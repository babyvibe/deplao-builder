/**
 * Nhãn & tin nhanh mở rộng — hội thoại theo nhãn, gán hàng loạt, thứ tự/bật tắt, sao chép sang tài khoản khác,
 * gán/gỡ nhãn Zalo trên server, tin nhắn nhanh trên server Zalo.
 * Mirror UI: ConversationList.tsx handleAssignLabel (đọc nhãn mới nhất → mỗi hội thoại một nhãn Zalo →
 * zalo:updateLabels có labelDiffs để workflow chạy, thử lại khi "Outdated"), QuickMessageManager.tsx,
 * Cài đặt → Hội thoại → Nhãn / Tin nhắn nhanh (db:setLocalLabelOrder, db:cloneLocalLabels…).
 */
import { s } from '../schema';
import { AccountInfo, ApiContext, ApiError, route, RouteDef } from '../types';
import { unwrapIpcResult } from '../IpcInvoker';
import { CHANNELS, requireOnline, unsupported, zaloAuth } from '../channels/ChannelActions';
import { threadTypeOf } from './chat';
import { accountParams, notFound, scrub } from './common';

const labelIdParams = s.object({ labelId: s.int().min(1) });

async function localLabels(ctx: ApiContext, accountId?: string): Promise<any[]> {
    return (await ctx.call('db:getLocalLabels', accountId ? { zaloId: accountId } : {}))?.labels || [];
}

async function localQuickMessages(ctx: ApiContext, accountId: string): Promise<any[]> {
    return (await ctx.call('db:getLocalQuickMessages', { zaloId: accountId }))?.items || [];
}

function mapZaloQuickMessage(i: any): any {
    return {
        id: Number(i?.id),
        keyword: i?.keyword || '',
        title: i?.message?.title || '',
        has_media: !!i?.media,
        updated_at: Number(i?.lastModified || i?.createdTime || 0),
    };
}

/**
 * Gán/gỡ một nhãn Zalo cho hội thoại — đúng như handleAssignLabel: đọc nhãn mới nhất, mỗi hội thoại
 * chỉ thuộc một nhãn (gỡ khỏi nhãn khác), nhóm dùng tiền tố "g", thử lại một lần khi version cũ.
 */
export async function setZaloLabel(ctx: ApiContext, acc: AccountInfo, labelId: number, threadId: string, assign: boolean): Promise<{ changed: boolean }> {
    requireOnline(acc);
    const auth = await zaloAuth(ctx, acc.id);
    const isGroup = (await threadTypeOf(ctx, acc.id, threadId)) === 'group';
    const key = isGroup ? `g${threadId}` : threadId;

    const attempt = async (): Promise<{ changed: boolean; res?: any }> => {
        const fresh = await ctx.call('zalo:getLabels', { auth });
        const labels: any[] = fresh?.response?.labelData || [];
        const version = fresh?.response?.version || 0;
        const target = labels.find(l => Number(l.id) === labelId);
        if (!target) notFound(`nhãn Zalo ${labelId}`);
        const has = (target.conversations || []).includes(key) || (target.conversations || []).includes(threadId);
        if (has === assign) return { changed: false };
        const updated = labels.map(l => {
            const filtered = (l.conversations || []).filter((c: string) => c !== key && c !== threadId);
            return Number(l.id) === labelId ? { ...l, conversations: assign ? [...filtered, key] : filtered } : { ...l, conversations: filtered };
        });
        const labelDiffs = [{
            threadId, threadType: isGroup ? 1 : 0, labelId: target.id,
            labelText: target.text || '', labelColor: target.color || '', labelEmoji: target.emoji || '',
            action: assign ? 'assigned' : 'removed',
        }];
        return { changed: true, res: await ctx.ipc('zalo:updateLabels', { auth, labelData: updated, version, labelDiffs }) };
    };

    let r = await attempt();
    if (r.changed && r.res?.success === false && /Outdated/i.test(String(r.res?.error || ''))) r = await attempt();
    if (r.changed) unwrapIpcResult(r.res);
    return { changed: r.changed };
}

export function labelExtraRoutes(): RouteDef[] {
    const tags = ['Nhãn & tin nhanh'];
    return [
        // ── Nhãn (local) ───────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/labels/:labelId/conversations', scope: 'chat:read', tags, operationId: 'listLabelConversations',
            summary: 'Hội thoại đang gắn một nhãn',
            params: s.object({ accountId: s.id(), labelId: s.int().min(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const rows: any[] = (await ctx.call('db:getLocalLabelThreads', { zaloId: acc.id }))?.threads || [];
                const ids = rows.filter(r => Number(r.label_id) === ctx.params.labelId).map(r => String(r.thread_id));
                if (!ids.length) return [];
                const found = (await ctx.call('db:searchContactsForPicker', { zaloId: acc.id, ids, limit: 200 }))?.items || [];
                const byId = new Map<string, any>(found.map((c: any) => [String(c.id), c]));
                return ids.map(id => {
                    const c = byId.get(id);
                    return { thread_id: id, name: c?.name ?? '', type: c?.type ?? 'user', avatar_url: c?.avatar || '', last_activity: c?.lastActivity || 0 };
                });
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/labels/bulk-assign', scope: 'chat:manage', tags, operationId: 'bulkAssignLabels',
            summary: 'Gán nhiều nhãn cho nhiều hội thoại trong một lần',
            description: 'Một transaction như thao tác gán hàng loạt trong app. Khác gán từng nhãn: không bắn workflow "Khi gán nhãn".',
            params: accountParams,
            body: s.object({ label_ids: s.array(s.int().min(1)).min(1).max(50), thread_ids: s.array(s.id()).min(1).max(1000) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const known = new Set((await localLabels(ctx, acc.id)).map(l => Number(l.id)));
                for (const id of ctx.body.label_ids) if (!known.has(id)) notFound(`nhãn ${id}`);
                const r = await ctx.call('db:bulkAssignLocalLabelToThread', { zaloId: acc.id, labelIds: ctx.body.label_ids, threadIds: ctx.body.thread_ids });
                return { assigned: Number(r?.count) || 0 };
            },
        }),
        route({
            method: 'PUT', path: '/labels/order', scope: 'chat:manage', tags, operationId: 'reorderLabels',
            summary: 'Sắp xếp thứ tự nhãn (theo mảng id)',
            body: s.object({ label_ids: s.array(s.int().min(1)).min(1).max(300) }),
            handler: async ctx => {
                const known = new Set((await localLabels(ctx)).map(l => Number(l.id)));
                for (const id of ctx.body.label_ids) if (!known.has(id)) notFound(`nhãn ${id}`);
                for (const [i, id] of ctx.body.label_ids.entries()) await ctx.call('db:setLocalLabelOrder', { id, order: i });
                return { ordered: ctx.body.label_ids.length };
            },
        }),
        route({
            method: 'PUT', path: '/labels/:labelId/active', scope: 'chat:manage', tags, operationId: 'setLabelActive',
            summary: 'Bật / ẩn nhãn',
            params: labelIdParams,
            body: s.object({ active: s.boolean() }),
            handler: async ctx => {
                if (!(await localLabels(ctx)).some(l => Number(l.id) === ctx.params.labelId)) notFound(`nhãn ${ctx.params.labelId}`);
                await ctx.call('db:setLocalLabelActive', { id: ctx.params.labelId, isActive: ctx.body.active ? 1 : 0 });
                return { active: ctx.body.active };
            },
        }),
        route({
            method: 'POST', path: '/labels/clone', scope: 'chat:manage', tags, operationId: 'cloneLabels',
            summary: 'Sao chép bộ nhãn của tài khoản này sang tài khoản khác',
            body: s.object({ from_account_id: s.id(), to_account_id: s.id() }),
            handler: async ctx => {
                const from = await ctx.account(ctx.body.from_account_id);
                const to = await ctx.account(ctx.body.to_account_id);
                if (from.id === to.id) throw new ApiError(400, 'VALIDATION_ERROR', 'Hai tài khoản phải khác nhau');
                const r = await ctx.call('db:cloneLocalLabels', { sourceZaloId: from.id, targetZaloId: to.id });
                return { cloned: Number(r?.count) || 0 };
            },
        }),

        // ── Nhãn Zalo (server) ─────────────────────────────────────────────
        ...([true, false] as const).map(assign => route({
            method: assign ? 'POST' : 'DELETE', path: '/accounts/:accountId/zalo-labels/:labelId/conversations/:threadId', scope: 'chat:manage', tags,
            operationId: assign ? 'assignZaloLabel' : 'removeZaloLabel',
            summary: assign ? 'Gắn nhãn Zalo cho hội thoại (mỗi hội thoại một nhãn)' : 'Gỡ nhãn Zalo khỏi hội thoại',
            description: 'Đồng bộ lên Zalo (hiện trên điện thoại). Gắn nhãn mới sẽ gỡ nhãn Zalo cũ của hội thoại như trong app; workflow "Khi gán hoặc gỡ nhãn" vẫn chạy.',
            params: s.object({ accountId: s.id(), labelId: s.int().min(0), threadId: s.id() }),
            handler: async (ctx: ApiContext) => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'nhãn Zalo');
                const r = await setZaloLabel(ctx, acc, ctx.params.labelId, ctx.params.threadId, assign);
                return { assigned: assign, changed: r.changed };
            },
        })),

        // ── Tin nhắn nhanh (local) ─────────────────────────────────────────
        route({
            method: 'PUT', path: '/accounts/:accountId/quick-messages/order', scope: 'chat:manage', tags, operationId: 'reorderQuickMessages',
            summary: 'Sắp xếp thứ tự tin nhắn nhanh',
            params: accountParams,
            body: s.object({ ids: s.array(s.int().min(1)).min(1).max(300) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const own = new Set((await localQuickMessages(ctx, acc.id)).map(q => Number(q.id)));
                for (const id of ctx.body.ids) if (!own.has(id)) notFound(`tin nhắn nhanh ${id}`);
                for (const [i, id] of ctx.body.ids.entries()) await ctx.call('db:setLocalQMOrder', { id, order: i });
                return { ordered: ctx.body.ids.length };
            },
        }),
        route({
            method: 'PUT', path: '/accounts/:accountId/quick-messages/:id/active', scope: 'chat:manage', tags, operationId: 'setQuickMessageActive',
            summary: 'Bật / tắt một tin nhắn nhanh',
            params: s.object({ accountId: s.id(), id: s.int().min(1) }),
            body: s.object({ active: s.boolean() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (!(await localQuickMessages(ctx, acc.id)).some(q => Number(q.id) === ctx.params.id)) notFound(`tin nhắn nhanh ${ctx.params.id}`);
                await ctx.call('db:setLocalQMActive', { id: ctx.params.id, isActive: ctx.body.active ? 1 : 0 });
                return { active: ctx.body.active };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/quick-messages/clone', scope: 'chat:manage', tags, operationId: 'cloneQuickMessages',
            summary: 'Sao chép tin nhắn nhanh sang tài khoản khác',
            params: accountParams,
            body: s.object({ to_account_id: s.id() }),
            handler: async ctx => {
                const from = await ctx.account(ctx.params.accountId);
                const to = await ctx.account(ctx.body.to_account_id);
                if (from.id === to.id) throw new ApiError(400, 'VALIDATION_ERROR', 'Hai tài khoản phải khác nhau');
                const r = await ctx.call('db:cloneLocalQuickMessages', { sourceZaloId: from.id, targetZaloId: to.id });
                return { cloned: Number(r?.count) || 0 };
            },
        }),

        // ── Tin nhắn nhanh trên server Zalo ───────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/zalo-quick-messages', scope: 'chat:read', tags, operationId: 'listZaloQuickMessages',
            summary: 'Tin nhắn nhanh lưu trên Zalo (dùng được cả trên điện thoại)',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'tin nhắn nhanh Zalo');
                requireOnline(acc);
                const r = await ctx.call('zalo:getQuickMessageList', { auth: await zaloAuth(ctx, acc.id) });
                return (r?.response?.items || []).map(mapZaloQuickMessage);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/zalo-quick-messages', scope: 'chat:manage', tags, operationId: 'createZaloQuickMessage',
            summary: 'Tạo tin nhắn nhanh trên Zalo',
            params: accountParams,
            body: s.object({ keyword: s.string().min(1).max(50).pattern(/^\S+$/), title: s.string().min(1).max(5000) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'tin nhắn nhanh Zalo');
                requireOnline(acc);
                const r = await ctx.call('zalo:addQuickMessage', { auth: await zaloAuth(ctx, acc.id), keyword: ctx.body.keyword, title: ctx.body.title });
                return scrub(r?.response?.item ? mapZaloQuickMessage(r.response.item) : r?.response ?? null);
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/zalo-quick-messages/:itemId', scope: 'chat:manage', tags, operationId: 'updateZaloQuickMessage',
            summary: 'Sửa tin nhắn nhanh trên Zalo',
            params: s.object({ accountId: s.id(), itemId: s.int().min(1) }),
            body: s.object({ keyword: s.string().min(1).max(50).pattern(/^\S+$/), title: s.string().min(1).max(5000) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'tin nhắn nhanh Zalo');
                requireOnline(acc);
                await ctx.call('zalo:updateQuickMessage', { auth: await zaloAuth(ctx, acc.id), keyword: ctx.body.keyword, title: ctx.body.title, itemId: ctx.params.itemId });
                return { updated: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/zalo-quick-messages/:itemId', scope: 'chat:manage', tags, operationId: 'deleteZaloQuickMessage',
            summary: 'Xoá tin nhắn nhanh trên Zalo',
            params: s.object({ accountId: s.id(), itemId: s.int().min(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'tin nhắn nhanh Zalo');
                requireOnline(acc);
                await ctx.call('zalo:removeQuickMessage', { auth: await zaloAuth(ctx, acc.id), itemIds: [ctx.params.itemId] });
                return { deleted: true };
            },
        }),
    ];
}
