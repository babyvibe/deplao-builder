/**
 * Nhóm Nhãn, tin nhắn nhanh, sticker.
 * Kênh IPC: db:getLocalLabels, db:upsertLocalLabel, db:deleteLocalLabel, db:getThreadLocalLabels,
 * db:assignLocalLabelToThread (phát workflow trigger.labelAssigned như UI), db:removeLocalLabelFromThread,
 * zalo:getLabels, db:getLocalQuickMessages, db:upsertLocalQuickMessage, db:deleteLocalQuickMessage,
 * db:getRecentStickers, db:getStickerPacks, db:getStickersByPackId, db:getKeywordStickers.
 */
import { s } from '../schema';
import { ApiContext, route, RouteDef } from '../types';
import { accountParams, notFound, threadParams } from './common';

const labelBody = s.object({
    name: s.string().min(1).max(100),
    color: s.string().max(20).default('#3B82F6'),
    text_color: s.string().max(20).default('#FFFFFF'),
    emoji: s.string().max(16).default('🏷️'),
    account_ids: s.array(s.string()).max(200).optional().describe('Chỉ hiện ở các tài khoản này; bỏ trống = mọi tài khoản'),
    shortcut: s.string().max(20).optional(),
});

function mapLabel(row: any): any {
    if (!row) return null;
    return {
        id: Number(row.id),
        name: row.name,
        color: row.color,
        text_color: row.text_color,
        emoji: row.emoji,
        account_ids: String(row.page_ids || '').split(',').map((v: string) => v.trim()).filter(Boolean),
        is_active: row.is_active === undefined ? true : !!row.is_active,
        sort_order: row.sort_order ?? null,
        shortcut: row.shortcut ?? null,
    };
}

async function threadType(ctx: ApiContext, accountId: string, threadId: string): Promise<number> {
    try {
        const res = await ctx.call('db:getContactById', { zaloId: accountId, contactId: threadId });
        return res?.contact?.contact_type === 'group' ? 1 : 0;
    } catch {
        return 0;
    }
}

export function labelRoutes(): RouteDef[] {
    const tags = ['Nhãn & tin nhanh'];
    return [
        route({
            method: 'GET', path: '/accounts/:accountId/labels', scope: 'chat:read', tags, operationId: 'listLabels',
            summary: 'Nhãn (local) dùng được ở tài khoản',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:getLocalLabels', { zaloId: acc.id });
                return (res?.labels || []).map(mapLabel);
            },
        }),
        route({
            method: 'POST', path: '/labels', scope: 'chat:manage', tags, operationId: 'createLabel',
            summary: 'Tạo nhãn',
            body: labelBody,
            handler: async ctx => {
                const b = ctx.body;
                for (const id of b.account_ids || []) await ctx.account(id);
                const res = await ctx.call('db:upsertLocalLabel', {
                    label: {
                        name: b.name, color: b.color, textColor: b.text_color, emoji: b.emoji,
                        pageIds: (b.account_ids || []).join(','), shortcut: b.shortcut,
                    },
                });
                return { id: Number(res?.id) };
            },
        }),
        route({
            method: 'PATCH', path: '/labels/:labelId', scope: 'chat:manage', tags, operationId: 'updateLabel',
            summary: 'Sửa nhãn',
            params: s.object({ labelId: s.int().min(1) }),
            body: labelBody.partial(),
            handler: async ctx => {
                const all = await ctx.call('db:getLocalLabels', {});
                const current = (all?.labels || []).find((l: any) => Number(l.id) === ctx.params.labelId);
                if (!current) notFound(`nhãn ${ctx.params.labelId}`);
                const b = ctx.body;
                for (const id of b.account_ids || []) await ctx.account(id);
                await ctx.call('db:upsertLocalLabel', {
                    label: {
                        id: ctx.params.labelId,
                        name: b.name ?? current.name,
                        color: b.color ?? current.color,
                        textColor: b.text_color ?? current.text_color,
                        emoji: b.emoji ?? current.emoji,
                        pageIds: b.account_ids ? b.account_ids.join(',') : current.page_ids,
                        shortcut: b.shortcut ?? current.shortcut,
                        isActive: current.is_active,
                        sortOrder: current.sort_order,
                    },
                });
                return { id: ctx.params.labelId };
            },
        }),
        route({
            method: 'DELETE', path: '/labels/:labelId', scope: 'chat:manage', tags, operationId: 'deleteLabel',
            summary: 'Xoá nhãn (gỡ khỏi mọi hội thoại)',
            params: s.object({ labelId: s.int().min(1) }),
            handler: async ctx => {
                await ctx.call('db:deleteLocalLabel', { id: ctx.params.labelId });
                return { deleted: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/labels', scope: 'chat:read', tags, operationId: 'listConversationLabels',
            summary: 'Nhãn đang gán cho hội thoại',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:getThreadLocalLabels', { zaloId: acc.id, threadId: ctx.params.threadId });
                return (res?.labels || []).map(mapLabel);
            },
        }),
        route({
            method: 'PUT', path: '/accounts/:accountId/conversations/:threadId/labels', scope: 'chat:manage', tags, operationId: 'setConversationLabels',
            summary: 'Đặt đúng tập nhãn cho hội thoại (gán thiếu, gỡ thừa)',
            description: 'Mỗi lần gán/gỡ đi qua cùng handler UI dùng nên workflow "Khi gán hoặc gỡ nhãn" vẫn chạy.',
            params: threadParams,
            body: s.object({ label_ids: s.array(s.int().min(1)).max(100) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                const [allRes, curRes] = await Promise.all([
                    ctx.call('db:getLocalLabels', { zaloId: acc.id }),
                    ctx.call('db:getThreadLocalLabels', { zaloId: acc.id, threadId }),
                ]);
                const byId = new Map<number, any>((allRes?.labels || []).map((l: any) => [Number(l.id), l]));
                const desired = new Set<number>(ctx.body.label_ids);
                for (const id of desired) if (!byId.has(id)) notFound(`nhãn ${id}`);
                const current = new Set<number>((curRes?.labels || []).map((l: any) => Number(l.id ?? l.label_id)));
                const tt = await threadType(ctx, acc.id, threadId);
                const added: number[] = [];
                const removed: number[] = [];
                for (const id of desired) {
                    if (current.has(id)) continue;
                    const l = byId.get(id);
                    await ctx.call('db:assignLocalLabelToThread', {
                        zaloId: acc.id, labelId: id, threadId, threadType: tt, labelText: l?.name || '', labelColor: l?.color || '', labelEmoji: l?.emoji || '',
                    });
                    added.push(id);
                }
                for (const id of current) {
                    if (desired.has(id)) continue;
                    const l = byId.get(id);
                    await ctx.call('db:removeLocalLabelFromThread', {
                        zaloId: acc.id, labelId: id, threadId, threadType: tt, labelText: l?.name || '', labelColor: l?.color || '', labelEmoji: l?.emoji || '',
                    });
                    removed.push(id);
                }
                return { added, removed };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/labels/:labelId', scope: 'chat:manage', tags, operationId: 'addConversationLabel',
            summary: 'Gán một nhãn cho hội thoại',
            params: s.object({ accountId: s.id(), threadId: s.id(), labelId: s.int().min(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const all = await ctx.call('db:getLocalLabels', { zaloId: acc.id });
                const l = (all?.labels || []).find((x: any) => Number(x.id) === ctx.params.labelId);
                if (!l) notFound(`nhãn ${ctx.params.labelId}`);
                await ctx.call('db:assignLocalLabelToThread', {
                    zaloId: acc.id, labelId: ctx.params.labelId, threadId: ctx.params.threadId,
                    threadType: await threadType(ctx, acc.id, ctx.params.threadId), labelText: l.name, labelColor: l.color, labelEmoji: l.emoji,
                });
                return { assigned: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId/labels/:labelId', scope: 'chat:manage', tags, operationId: 'removeConversationLabel',
            summary: 'Gỡ một nhãn khỏi hội thoại',
            params: s.object({ accountId: s.id(), threadId: s.id(), labelId: s.int().min(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const all = await ctx.call('db:getLocalLabels', { zaloId: acc.id });
                const l = (all?.labels || []).find((x: any) => Number(x.id) === ctx.params.labelId);
                await ctx.call('db:removeLocalLabelFromThread', {
                    zaloId: acc.id, labelId: ctx.params.labelId, threadId: ctx.params.threadId,
                    threadType: await threadType(ctx, acc.id, ctx.params.threadId),
                    labelText: l?.name || '', labelColor: l?.color || '', labelEmoji: l?.emoji || '',
                });
                return { removed: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/zalo-labels', scope: 'chat:read', tags, operationId: 'listZaloLabels',
            summary: 'Nhãn trên server Zalo của tài khoản (chỉ Zalo, cần online)',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== 'zalo') return [];
                const res = await ctx.call('zalo:getLabels', { auth: await ctx.zaloAuth(acc.id) });
                return res?.response ?? res?.labels ?? res;
            },
        }),

        // ── Tin nhắn nhanh ────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/quick-messages', scope: 'chat:read', tags, operationId: 'listQuickMessages',
            summary: 'Tin nhắn nhanh (/keyword) của tài khoản',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:getLocalQuickMessages', { zaloId: acc.id });
                return res?.items || [];
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/quick-messages', scope: 'chat:manage', tags, operationId: 'upsertQuickMessage',
            summary: 'Tạo hoặc cập nhật tin nhắn nhanh (theo keyword)',
            params: accountParams,
            body: s.object({
                keyword: s.string().min(1).max(50),
                title: s.string().max(5000),
                media: s.any().optional().describe('Giữ nguyên định dạng media của app (tuỳ chọn)'),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:upsertLocalQuickMessage', { zaloId: acc.id, item: ctx.body });
                return { id: Number(res?.id) };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/quick-messages/:id', scope: 'chat:manage', tags, operationId: 'deleteQuickMessage',
            summary: 'Xoá tin nhắn nhanh',
            params: s.object({ accountId: s.id(), id: s.int().min(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await ctx.call('db:deleteLocalQuickMessage', { zaloId: acc.id, id: ctx.params.id });
                return { deleted: true };
            },
        }),

        // ── Sticker ───────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/stickers/recent', scope: 'chat:read', tags, operationId: 'listRecentStickers',
            summary: 'Sticker dùng gần đây',
            query: s.object({ limit: s.int().min(1).max(100).default(30) }),
            handler: async ctx => (await ctx.call('db:getRecentStickers', { limit: ctx.query.limit }))?.stickers || [],
        }),
        route({
            method: 'GET', path: '/sticker-packs', scope: 'chat:read', tags, operationId: 'listStickerPacks',
            summary: 'Bộ sticker đã lưu',
            handler: async ctx => (await ctx.call('db:getStickerPacks'))?.packs || [],
        }),
        route({
            method: 'GET', path: '/sticker-packs/:catId/stickers', scope: 'chat:read', tags, operationId: 'listStickersInPack',
            summary: 'Sticker trong một bộ',
            params: s.object({ catId: s.int() }),
            handler: async ctx => (await ctx.call('db:getStickersByPackId', { catId: ctx.params.catId }))?.stickers || [],
        }),
        route({
            method: 'GET', path: '/stickers/search', scope: 'chat:read', tags, operationId: 'searchStickers',
            summary: 'ID sticker theo từ khoá (đã cache)',
            query: s.object({ keyword: s.string().min(1).max(50) }),
            handler: async ctx => ({ sticker_ids: (await ctx.call('db:getKeywordStickers', { keyword: ctx.query.keyword }))?.stickerIds || [] }),
        }),
    ];
}
