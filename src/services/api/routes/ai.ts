/**
 * Trợ lý AI và báo cáo.
 * Kênh IPC: ai:listAssistants, ai:getAssistant, ai:getDefault, ai:saveAssistant, ai:deleteAssistant,
 * ai:chat, ai:suggest, ai:getAccountAssistant, ai:setAccountAssistant, ai:getUsageLogs, ai:getUsageStats,
 * analytics:* (11 báo cáo).
 */
import { s } from '../schema';
import { ApiError, route, RouteDef } from '../types';
import { accountParams, mapMessage, notFound, scrub } from './common';

function mapAssistant(a: any): any {
    if (!a) return null;
    const { api_key_encrypted, apiKey, api_key, ...rest } = a;
    return { ...scrub(rest), has_api_key: !!(api_key_encrypted || apiKey || api_key) };
}

/** Thông tin tối thiểu để chọn trợ lý (scope ai:use): không system prompt, tri thức hay key. */
function assistantOption(a: any): any {
    return {
        id: String(a?.id ?? ''),
        name: String(a?.name ?? ''),
        platform: String(a?.platform ?? ''),
        model: String(a?.model ?? ''),
        enabled: a?.enabled !== false && a?.enabled !== 0,
        is_default: !!(a?.isDefault ?? a?.is_default),
    };
}

const REPORTS: Record<string, { channel: string; perAccount: boolean; needsRange: boolean; label: string }> = {
    'dashboard': { channel: 'analytics:dashboardOverview', perAccount: true, needsRange: false, label: 'Tổng quan' },
    'message-volume': { channel: 'analytics:messageVolume', perAccount: true, needsRange: true, label: 'Lượng tin theo giờ/ngày' },
    'peak-hours': { channel: 'analytics:peakHours', perAccount: true, needsRange: true, label: 'Giờ cao điểm' },
    'contact-growth': { channel: 'analytics:contactGrowth', perAccount: true, needsRange: true, label: 'Tăng trưởng liên hệ' },
    'segmentation': { channel: 'analytics:contactSegmentation', perAccount: true, needsRange: false, label: 'Phân khúc liên hệ' },
    'campaign-comparison': { channel: 'analytics:campaignComparison', perAccount: true, needsRange: false, label: 'So sánh chiến dịch' },
    'friend-requests': { channel: 'analytics:friendRequests', perAccount: true, needsRange: true, label: 'Lời mời kết bạn' },
    'workflows': { channel: 'analytics:workflowAnalytics', perAccount: true, needsRange: true, label: 'Workflow' },
    'ai': { channel: 'analytics:aiAnalytics', perAccount: false, needsRange: true, label: 'AI' },
    'response-time': { channel: 'analytics:responseTime', perAccount: true, needsRange: true, label: 'Thời gian phản hồi' },
    'label-usage': { channel: 'analytics:labelUsage', perAccount: true, needsRange: true, label: 'Sử dụng nhãn' },
};

export function aiRoutes(): RouteDef[] {
    const tags = ['AI'];
    return [
        route({
            method: 'GET', path: '/ai/assistants', scope: 'ai:manage', tags, operationId: 'listAiAssistants',
            summary: 'Trợ lý AI (không trả API key)',
            handler: async ctx => ((await ctx.call('ai:listAssistants'))?.assistants || []).map(mapAssistant),
        }),
        route({
            method: 'GET', path: '/ai/assistants/:id', scope: 'ai:manage', tags, operationId: 'getAiAssistant',
            summary: 'Một trợ lý',
            params: s.object({ id: s.id() }),
            handler: async ctx => {
                const r = await ctx.call('ai:getAssistant', { id: ctx.params.id });
                if (!r?.assistant) notFound(`trợ lý ${ctx.params.id}`);
                return mapAssistant(r.assistant);
            },
        }),
        route({
            method: 'GET', path: '/ai/assistants/options', scope: 'ai:use', tags, operationId: 'listAiAssistantOptions',
            summary: 'Trợ lý để chọn khi gọi /ai/chat (chỉ tên, nền tảng, model — không prompt, không key)',
            handler: async ctx => ((await ctx.call('ai:listAssistants'))?.assistants || []).map(assistantOption),
        }),
        route({
            method: 'GET', path: '/ai/default', scope: 'ai:use', tags, operationId: 'getDefaultAiAssistant',
            summary: 'Trợ lý mặc định',
            handler: async ctx => mapAssistant((await ctx.call('ai:getDefault'))?.assistant ?? null),
        }),
        route({
            method: 'POST', path: '/ai/chat', scope: 'ai:use', tags, operationId: 'aiChat',
            summary: 'Hỏi trợ lý AI (dùng cấu hình, tri thức và hạn mức của trợ lý)',
            body: s.object({
                assistant_id: s.id().optional().describe('Bỏ trống = trợ lý mặc định'),
                messages: s.array(s.object({ role: s.enum(['user', 'assistant', 'system'] as const), content: s.string().max(100000) })).min(1).max(100),
                max_tokens: s.int().min(1).max(8000).optional(),
                temperature: s.number().min(0).max(2).optional(),
                raw_system: s.boolean().optional()
                    .describe('true = chỉ gửi đúng messages (kể cả system) tới model, không ghép system prompt / tri thức của trợ lý — cho ứng dụng tự lo prompt'),
            }),
            examples: { request: { messages: [{ role: 'user', content: 'Tóm tắt chính sách đổi trả' }] } },
            handler: async ctx => {
                let assistantId = ctx.body.assistant_id;
                if (!assistantId) {
                    const d = await ctx.call('ai:getDefault');
                    assistantId = d?.assistant?.id;
                    if (!assistantId) throw new ApiError(409, 'CONFLICT', 'Chưa có trợ lý AI mặc định');
                }
                const r = await ctx.call('ai:chat', {
                    assistantId, messages: ctx.body.messages, maxTokens: ctx.body.max_tokens, temperature: ctx.body.temperature,
                    rawSystem: ctx.body.raw_system === true,
                }, { timeoutMs: 180_000 });
                return { result: r?.result ?? null, total_tokens: r?.totalTokens ?? null, prompt_tokens: r?.promptTokens ?? null, completion_tokens: r?.completionTokens ?? null };
            },
        }),
        route({
            method: 'POST', path: '/ai/suggest', scope: 'ai:use', tags, operationId: 'aiSuggestReply',
            summary: 'Gợi ý câu trả lời cho hội thoại (như nút gợi ý trong chat)',
            body: s.object({
                account_id: s.id(),
                thread_id: s.id(),
                assistant_id: s.id().optional().describe('Bỏ trống = trợ lý gán cho tài khoản (vai trò gợi ý) hoặc mặc định'),
                history_limit: s.int().min(1).max(100).default(30),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.body.account_id);
                let assistantId = ctx.body.assistant_id;
                if (!assistantId) {
                    const own = await ctx.call('ai:getAccountAssistant', { zaloId: acc.id, role: 'suggestion' }).catch(() => null);
                    assistantId = own?.assistant?.id || own?.assistantId;
                }
                if (!assistantId) {
                    const d = await ctx.call('ai:getDefault');
                    assistantId = d?.assistant?.id;
                }
                if (!assistantId) throw new ApiError(409, 'CONFLICT', 'Chưa cấu hình trợ lý AI');
                const msgs = await ctx.call('db:getMessages', { zaloId: acc.id, threadId: ctx.body.thread_id, limit: ctx.body.history_limit });
                const chatHistory = (msgs?.messages || []).map(mapMessage).reverse().map((m: any) => ({
                    role: m.is_self ? 'assistant' : 'user', content: m.text || m.content, isSelf: m.is_self, timestamp: m.timestamp,
                }));
                const r = await ctx.call('ai:suggest', { assistantId, chatHistory }, { timeoutMs: 180_000 });
                const { success, ...rest } = r || {};
                return rest;
            },
        }),
        route({
            method: 'GET', path: '/ai/usage/stats', scope: 'ai:manage', tags, operationId: 'getAiUsageStats',
            summary: 'Thống kê token theo ngày',
            query: s.object({ assistant_id: s.id().optional(), days: s.int().min(1).max(365).default(30) }),
            handler: async ctx => {
                const r = await ctx.call('ai:getUsageStats', { assistantId: ctx.query.assistant_id, days: ctx.query.days });
                return r?.stats ?? r?.data ?? [];
            },
        }),
        route({
            method: 'GET', path: '/ai/usage/logs', scope: 'ai:manage', tags, operationId: 'getAiUsageLogs',
            summary: 'Nhật ký gọi AI',
            query: s.object({ assistant_id: s.id().optional(), from: s.timestamp().optional(), to: s.timestamp().optional(), limit: s.int().min(1).max(1000).default(100) }),
            handler: async ctx => {
                const r = await ctx.call('ai:getUsageLogs', { assistantId: ctx.query.assistant_id, dateFrom: ctx.query.from, dateTo: ctx.query.to, limit: ctx.query.limit });
                return r?.logs ?? [];
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/ai-assistant', scope: 'ai:use', tags, operationId: 'getAccountAiAssistant',
            summary: 'Trợ lý gán cho tài khoản (gợi ý / panel)',
            params: accountParams,
            query: s.object({ role: s.enum(['suggestion', 'panel'] as const).default('suggestion') }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const r = await ctx.call('ai:getAccountAssistant', { zaloId: acc.id, role: ctx.query.role });
                return mapAssistant(r?.assistant ?? null);
            },
        }),

        // ── Báo cáo ────────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/analytics/:report', scope: 'analytics:read', tags: ['Báo cáo'], operationId: 'getAnalyticsReport',
            summary: 'Báo cáo (dashboard, message-volume, peak-hours, contact-growth, segmentation, campaign-comparison, friend-requests, workflows, ai, response-time, label-usage)',
            params: s.object({ report: s.enum(Object.keys(REPORTS) as any) }),
            query: s.object({
                account_id: s.id().optional().describe('Bắt buộc với báo cáo theo tài khoản'),
                from: s.timestamp().optional().describe('Epoch ms (mặc định 30 ngày trước)'),
                to: s.timestamp().optional().describe('Epoch ms (mặc định bây giờ)'),
                granularity: s.enum(['hour', 'day'] as const).default('day'),
                thread_type: s.enum(['user', 'group'] as const).optional(),
            }),
            handler: async ctx => {
                const rep = REPORTS[ctx.params.report];
                const now = Date.now();
                const sinceTs = ctx.query.from ?? now - 30 * 86_400_000;
                const untilTs = ctx.query.to ?? now;
                const payload: any = { sinceTs, untilTs, granularity: ctx.query.granularity };
                if (ctx.query.thread_type) payload.threadType = ctx.query.thread_type === 'group' ? 1 : 0;
                if (rep.perAccount) {
                    if (!ctx.query.account_id) throw new ApiError(400, 'VALIDATION_ERROR', 'Báo cáo này cần account_id');
                    const acc = await ctx.account(ctx.query.account_id);
                    payload.zaloId = acc.id;
                } else if (ctx.principal.accountIds !== null) {
                    throw new ApiError(403, 'FORBIDDEN_ACCOUNT', 'Báo cáo toàn hệ thống cần key không giới hạn tài khoản');
                }
                const r = await ctx.call(rep.channel, payload);
                const { success, ...rest } = r || {};
                return { report: ctx.params.report, label: rep.label, from: sinceTs, to: untilTs, ...rest };
            },
        }),
    ];
}
