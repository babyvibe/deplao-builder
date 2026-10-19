/**
 * CRM: khách hàng, ghi chú, chiến dịch gửi tin hàng loạt.
 * Phân loại khách dùng Nhãn (xem nhóm "Nhãn & tin nhanh") — giống UI.
 * Kênh IPC: crm:getContacts, crm:getContactStats, crm:getNotes, crm:saveNote, crm:deleteNote,
 * crm:getCampaigns, crm:saveCampaign, crm:deleteCampaign, crm:cloneCampaign, crm:updateCampaignStatus,
 * crm:addCampaignContacts, crm:getCampaignContacts, crm:deleteCampaignContacts, crm:deleteAllCampaignContacts,
 * crm:getSendLog, crm:getCampaignStats, crm:getActivityStats, crm:getQueueStatus, db:getBankCards, db:upsertBankCard, db:deleteBankCard,
 * db:updateContactProfile, db:setContactAlias, db:getContactById, db:getMessages.
 */
import { s } from '../schema';
import { ApiContext, ApiError, route, RouteDef } from '../types';
import { accountParams, mapConversation, mapMessage, notFound, offsetPage, pageShape } from './common';

const contactParams = s.object({ accountId: s.id(), contactId: s.id() });
const campaignParams = s.object({ accountId: s.id(), campaignId: s.int().min(1) });

const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'done'] as const;

const bankCardBody = s.object({
    bank_name: s.string().min(1).max(100),
    bin_bank: s.int().min(100000).max(999999).describe('Mã BIN ngân hàng (6 số, vd 970436 = Vietcombank)'),
    account_number: s.string().min(4).max(40),
    account_name: s.string().min(1).max(100),
    is_default: s.boolean().default(false),
});

const campaignBody = s.object({
    name: s.string().min(1).max(200),
    campaign_type: s.enum(['message', 'friend_request', 'mixed'] as const).default('message'),
    template_message: s.union(s.string().max(20000), s.any('object')).default('').describe('Nội dung gửi; hỗ trợ biến như UI ({name}...) hoặc JSON blocks của trình soạn'),
    friend_request_message: s.string().max(500).default(''),
    mixed_config: s.union(s.string(), s.any('object')).optional(),
    delay_seconds: s.int().min(5).max(86400).default(60).describe('Giãn cách giữa 2 liên hệ (giây); hàng đợi luôn chờ tối thiểu 30 giây'),
});

async function findCampaign(ctx: ApiContext, accountId: string, campaignId: number): Promise<any> {
    const res = await ctx.call('crm:getCampaigns', { zaloId: accountId });
    const c = (res?.campaigns || []).find((x: any) => Number(x.id) === Number(campaignId));
    if (!c) notFound(`chiến dịch ${campaignId}`);
    return c;
}

function campaignPayload(body: any, existing?: any): any {
    const toStr = (v: any) => (v === undefined ? undefined : typeof v === 'string' ? v : JSON.stringify(v));
    return {
        ...(existing || {}),
        ...(existing ? { id: existing.id } : {}),
        name: body.name ?? existing?.name,
        campaign_type: body.campaign_type ?? existing?.campaign_type ?? 'message',
        template_message: toStr(body.template_message) ?? existing?.template_message ?? '',
        friend_request_message: body.friend_request_message ?? existing?.friend_request_message ?? '',
        mixed_config: toStr(body.mixed_config) ?? existing?.mixed_config ?? '{}',
        delay_seconds: body.delay_seconds ?? existing?.delay_seconds ?? 60,
        status: existing?.status ?? 'draft',
    };
}

export function crmRoutes(): RouteDef[] {
    const tags = ['CRM'];
    const ctags = ['Chiến dịch'];
    return [
        route({
            method: 'GET', path: '/accounts/:accountId/crm/contacts', scope: 'crm:read', tags, operationId: 'listCrmContacts',
            summary: 'Khách hàng (bạn bè, người lạ, nhóm) với bộ lọc như trang CRM',
            params: accountParams,
            query: s.object({
                ...pageShape,
                search: s.string().max(200).optional(),
                type: s.enum(['all', 'friend', 'non_friend', 'group'] as const).default('all'),
                sort_by: s.enum(['name', 'last_message'] as const).default('last_message'),
                sort_dir: s.enum(['asc', 'desc'] as const).default('desc'),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { limit, offset, search, type, sort_by, sort_dir } = ctx.query;
                const res = await ctx.call('crm:getContacts', {
                    zaloId: acc.id,
                    opts: { search: search || undefined, contactType: type, sortBy: sort_by, sortDir: sort_dir, limit, offset },
                });
                const rows: any[] = res?.contacts || [];
                return offsetPage(rows.map(mapConversation), limit, offset, Number.isFinite(res?.total) ? Number(res.total) : undefined);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/crm/contacts/stats', scope: 'crm:read', tags, operationId: 'getCrmContactStats',
            summary: 'Thống kê khách hàng (tổng, bạn bè, ghi chú)',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { success, ...rest } = await ctx.call('crm:getContactStats', { zaloId: acc.id });
                return rest;
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/crm/contacts/:contactId', scope: 'crm:read', tags, operationId: 'getCrmContact',
            summary: 'Hồ sơ khách: thông tin, nhãn, ghi chú, 5 tin gần nhất',
            params: contactParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const id = ctx.params.contactId;
                const c = await ctx.call('db:getContactById', { zaloId: acc.id, contactId: id });
                if (!c?.contact) notFound(`khách hàng ${id}`);
                const [labels, notes, msgs] = await Promise.all([
                    ctx.call('db:getThreadLocalLabels', { zaloId: acc.id, threadId: id }).catch(() => null),
                    ctx.call('crm:getNotes', { zaloId: acc.id, contactId: id }).catch(() => null),
                    ctx.call('db:getMessages', { zaloId: acc.id, threadId: id, limit: 5 }).catch(() => null),
                ]);
                return {
                    ...mapConversation(c.contact),
                    labels: labels?.labels || [],
                    notes: notes?.notes || [],
                    recent_messages: (msgs?.messages || []).map(mapMessage),
                };
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/crm/contacts/:contactId', scope: 'crm:write', tags, operationId: 'updateCrmContact',
            summary: 'Cập nhật số điện thoại / tên hiển thị / biệt danh (lưu trên Deplao)',
            params: contactParams,
            body: s.object({
                phone: s.string().max(30).optional(),
                display_name: s.string().max(200).optional(),
                alias: s.string().max(100).optional(),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const id = ctx.params.contactId;
                const c = await ctx.call('db:getContactById', { zaloId: acc.id, contactId: id });
                if (!c?.contact) notFound(`khách hàng ${id}`);
                const b = ctx.body;
                if (b.phone !== undefined || b.display_name !== undefined) {
                    await ctx.call('db:updateContactProfile', {
                        zaloId: acc.id, contactId: id,
                        displayName: b.display_name ?? c.contact.display_name,
                        avatarUrl: c.contact.avatar_url,
                        phone: b.phone ?? c.contact.phone,
                        contactType: c.contact.contact_type,
                        manualDetails: true,
                    });
                }
                if (b.alias !== undefined) await ctx.call('db:setContactAlias', { zaloId: acc.id, contactId: id, alias: b.alias });
                return { updated: true };
            },
        }),

        // ── Ghi chú ───────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/crm/contacts/:contactId/notes', scope: 'crm:read', tags, operationId: 'listCrmNotes',
            summary: 'Ghi chú của khách',
            params: contactParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return (await ctx.call('crm:getNotes', { zaloId: acc.id, contactId: ctx.params.contactId }))?.notes || [];
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/crm/contacts/:contactId/notes', scope: 'crm:write', tags, operationId: 'createCrmNote',
            summary: 'Thêm ghi chú',
            params: contactParams,
            body: s.object({ content: s.string().min(1).max(10000), topic_id: s.string().optional() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const c = await ctx.call('db:getContactById', { zaloId: acc.id, contactId: ctx.params.contactId });
                const res = await ctx.call('crm:saveNote', {
                    zaloId: acc.id,
                    note: {
                        contact_id: ctx.params.contactId,
                        contact_type: c?.contact?.contact_type === 'group' ? 'group' : 'user',
                        content: ctx.body.content,
                        topic_id: ctx.body.topic_id ?? null,
                    },
                });
                return { id: Number(res?.id) };
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/crm/notes/:noteId', scope: 'crm:write', tags, operationId: 'updateCrmNote',
            summary: 'Sửa ghi chú',
            params: s.object({ accountId: s.id(), noteId: s.int().min(1) }),
            body: s.object({ contact_id: s.id(), content: s.string().min(1).max(10000) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const notes = (await ctx.call('crm:getNotes', { zaloId: acc.id, contactId: ctx.body.contact_id }))?.notes || [];
                const note = notes.find((n: any) => Number(n.id) === ctx.params.noteId);
                if (!note) notFound(`ghi chú ${ctx.params.noteId}`);
                await ctx.call('crm:saveNote', { zaloId: acc.id, note: { ...note, content: ctx.body.content } });
                return { id: ctx.params.noteId };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/crm/notes/:noteId', scope: 'crm:write', tags, operationId: 'deleteCrmNote',
            summary: 'Xoá ghi chú',
            params: s.object({ accountId: s.id(), noteId: s.int().min(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await ctx.call('crm:deleteNote', { zaloId: acc.id, noteId: ctx.params.noteId });
                return { deleted: true };
            },
        }),

        // ── Chiến dịch ────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/campaigns', scope: 'crm:read', tags: ctags, operationId: 'listCampaigns',
            summary: 'Chiến dịch của tài khoản',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return (await ctx.call('crm:getCampaigns', { zaloId: acc.id }))?.campaigns || [];
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/campaigns', scope: 'crm:write', tags: ctags, operationId: 'createCampaign',
            summary: 'Tạo chiến dịch (trạng thái draft)',
            params: accountParams,
            body: campaignBody,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('crm:saveCampaign', { zaloId: acc.id, campaign: { ...campaignPayload(ctx.body), channel: acc.channel } });
                return { id: Number(res?.id) };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/campaigns/:campaignId', scope: 'crm:read', tags: ctags, operationId: 'getCampaign',
            summary: 'Một chiến dịch',
            params: campaignParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return findCampaign(ctx, acc.id, ctx.params.campaignId);
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/campaigns/:campaignId', scope: 'crm:write', tags: ctags, operationId: 'updateCampaign',
            summary: 'Sửa chiến dịch',
            params: campaignParams,
            body: campaignBody.partial(),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const existing = await findCampaign(ctx, acc.id, ctx.params.campaignId);
                await ctx.call('crm:saveCampaign', { zaloId: acc.id, campaign: campaignPayload(ctx.body, existing) });
                return { id: ctx.params.campaignId };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/campaigns/:campaignId', scope: 'crm:write', tags: ctags, operationId: 'deleteCampaign',
            summary: 'Xoá chiến dịch',
            params: campaignParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await findCampaign(ctx, acc.id, ctx.params.campaignId);
                await ctx.call('crm:deleteCampaign', { zaloId: acc.id, campaignId: ctx.params.campaignId });
                return { deleted: true };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/campaigns/:campaignId/clone', scope: 'crm:write', tags: ctags, operationId: 'cloneCampaign',
            summary: 'Nhân bản chiến dịch',
            params: campaignParams,
            body: s.object({ name: s.string().max(200).optional(), include_contacts: s.boolean().default(false) }).optional(),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await findCampaign(ctx, acc.id, ctx.params.campaignId);
                const res = await ctx.call('crm:cloneCampaign', {
                    zaloId: acc.id, campaignId: ctx.params.campaignId,
                    includeContacts: !!ctx.body?.include_contacts, newName: ctx.body?.name,
                });
                return { id: Number(res?.id ?? res?.newId) || null };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/campaigns/:campaignId/status', scope: 'campaigns:run', tags: ctags, operationId: 'setCampaignStatus',
            summary: 'Chạy / tạm dừng / kết thúc chiến dịch',
            description: '`active` bắt đầu hàng đợi gửi theo tài khoản (giãn cách như cấu hình), `paused` tạm dừng, `done` kết thúc.',
            params: campaignParams,
            body: s.object({ status: s.enum(CAMPAIGN_STATUSES) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await findCampaign(ctx, acc.id, ctx.params.campaignId);
                await ctx.call('crm:updateCampaignStatus', { campaignId: ctx.params.campaignId, status: ctx.body.status });
                return { status: ctx.body.status };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/campaigns/:campaignId/contacts', scope: 'crm:read', tags: ctags, operationId: 'listCampaignContacts',
            summary: 'Người nhận của chiến dịch và trạng thái gửi',
            params: campaignParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await findCampaign(ctx, acc.id, ctx.params.campaignId);
                return (await ctx.call('crm:getCampaignContacts', { campaignId: ctx.params.campaignId }))?.contacts || [];
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/campaigns/:campaignId/contacts', scope: 'crm:write', tags: ctags, operationId: 'addCampaignContacts',
            summary: 'Thêm người nhận vào chiến dịch',
            params: campaignParams,
            body: s.object({
                contacts: s.array(s.object({
                    contact_id: s.id(),
                    display_name: s.string().max(200).optional(),
                    phone: s.string().max(30).optional(),
                    avatar: s.string().max(1000).optional(),
                })).min(1).max(5000),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await findCampaign(ctx, acc.id, ctx.params.campaignId);
                await ctx.call('crm:addCampaignContacts', {
                    zaloId: acc.id, campaignId: ctx.params.campaignId,
                    contacts: ctx.body.contacts.map((c: any) => ({ contactId: c.contact_id, displayName: c.display_name, phone: c.phone, avatar: c.avatar })),
                });
                return { added: ctx.body.contacts.length };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/campaigns/:campaignId/contacts/from-label', scope: 'crm:write', tags: ctags, operationId: 'addCampaignContactsFromLabel',
            summary: 'Thêm mọi hội thoại đang gắn một nhãn vào chiến dịch',
            params: campaignParams,
            body: s.object({ label_id: s.int().min(1), only_users: s.boolean().default(true).describe('Bỏ qua nhóm chat') }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await findCampaign(ctx, acc.id, ctx.params.campaignId);
                const rows: any[] = (await ctx.call('db:getLocalLabelThreads', { zaloId: acc.id }))?.threads || [];
                const ids = Array.from(new Set(rows.filter(r => Number(r.label_id) === ctx.body.label_id).map(r => String(r.thread_id)))).slice(0, 5000);
                if (!ids.length) return { added: 0 };
                const found: any[] = (await ctx.call('db:searchContactsForPicker', { zaloId: acc.id, ids, limit: 5000 }))?.items || [];
                const contacts = found
                    .filter(c => !ctx.body.only_users || c.type !== 'group')
                    .map(c => ({ contactId: String(c.id), displayName: c.name || String(c.id), phone: c.phone || '', avatar: c.avatar || '' }));
                if (contacts.length) await ctx.call('crm:addCampaignContacts', { zaloId: acc.id, campaignId: ctx.params.campaignId, contacts });
                return { added: contacts.length };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/campaigns/:campaignId/contacts/from-group', scope: 'crm:write', tags: ctags, operationId: 'addCampaignContactsFromGroup',
            summary: 'Thêm thành viên một nhóm (đã quét/lưu) vào chiến dịch',
            description: 'Như "Thêm vào chiến dịch" ở tab Thành viên nhóm. Thành viên lấy từ danh sách đã lưu (quét nhóm trong app trước nếu trống).',
            params: campaignParams,
            body: s.object({ group_id: s.id(), exclude_ids: s.array(s.id()).max(5000).default([]) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await findCampaign(ctx, acc.id, ctx.params.campaignId);
                const skip = new Set<string>([acc.id, ...ctx.body.exclude_ids]);
                const members: any[] = (await ctx.call('db:getGroupMembers', { zaloId: acc.id, groupId: ctx.body.group_id }))?.members || [];
                const contacts = members
                    .filter(m => m?.member_id && !skip.has(String(m.member_id)))
                    .slice(0, 5000)
                    .map(m => ({ contactId: String(m.member_id), displayName: m.display_name || String(m.member_id), avatar: m.avatar || '' }));
                if (contacts.length) await ctx.call('crm:addCampaignContacts', { zaloId: acc.id, campaignId: ctx.params.campaignId, contacts });
                return { added: contacts.length };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/campaigns/:campaignId/contacts', scope: 'crm:write', tags: ctags, operationId: 'removeCampaignContacts',
            summary: 'Xoá người nhận (theo danh sách hoặc tất cả)',
            params: campaignParams,
            body: s.object({ contact_ids: s.array(s.id()).max(5000).optional(), all: s.boolean().default(false) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await findCampaign(ctx, acc.id, ctx.params.campaignId);
                if (ctx.body.all) {
                    await ctx.call('crm:deleteAllCampaignContacts', { campaignId: ctx.params.campaignId });
                    return { removed: 'all' };
                }
                if (!ctx.body.contact_ids?.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Cần contact_ids hoặc all=true');
                await ctx.call('crm:deleteCampaignContacts', { campaignId: ctx.params.campaignId, contactIds: ctx.body.contact_ids });
                return { removed: ctx.body.contact_ids.length };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/campaigns/:campaignId/send-log', scope: 'crm:read', tags: ctags, operationId: 'getCampaignSendLog',
            summary: 'Nhật ký gửi của chiến dịch',
            params: campaignParams,
            query: s.object({ limit: s.int().min(1).max(1000).default(200) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const r = await ctx.call('crm:getSendLog', { zaloId: acc.id, opts: { campaignId: ctx.params.campaignId, limit: ctx.query.limit } });
                return r?.logs ?? r?.items ?? r?.log ?? [];
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/campaigns-stats', scope: 'crm:read', tags: ctags, operationId: 'getCampaignStats',
            summary: 'Thống kê chiến dịch nổi bật',
            params: accountParams,
            query: s.object({ limit: s.int().min(1).max(100).default(10) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return (await ctx.call('crm:getCampaignStats', { zaloId: acc.id, limit: ctx.query.limit }))?.stats || [];
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/campaigns-queue', scope: 'crm:read', tags: ctags, operationId: 'getCampaignQueueStatus',
            summary: 'Trạng thái hàng đợi gửi chiến dịch',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return (await ctx.call('crm:getQueueStatus', { zaloId: acc.id }))?.status ?? null;
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/crm/activity', scope: 'crm:read', tags, operationId: 'getCrmActivityStats',
            summary: 'Hoạt động CRM trong khoảng thời gian',
            params: accountParams,
            query: s.object({ since: s.timestamp().describe('Epoch ms'), until: s.timestamp().optional() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { success, ...rest } = await ctx.call('crm:getActivityStats', { zaloId: acc.id, sinceTs: ctx.query.since, untilTs: ctx.query.until });
                return rest;
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/bank-cards', scope: 'crm:read', tags, operationId: 'listBankCards',
            summary: 'Thẻ ngân hàng đã lưu để gửi cho khách',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return (await ctx.call('db:getBankCards', { zaloId: acc.id }))?.cards || [];
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/bank-cards', scope: 'crm:write', tags, operationId: 'createBankCard',
            summary: 'Lưu thẻ ngân hàng (để gửi nhanh cho khách)',
            params: accountParams,
            body: bankCardBody,
            examples: { request: { bank_name: 'Vietcombank', bin_bank: 970436, account_number: '0011001234567', account_name: 'NGUYEN VAN A', is_default: true } },
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const b = ctx.body;
                const r = await ctx.call('db:upsertBankCard', {
                    zaloId: acc.id,
                    card: { bank_name: b.bank_name, bin_bank: b.bin_bank, account_number: b.account_number, account_name: b.account_name, is_default: b.is_default ? 1 : 0 },
                });
                return { id: Number(r?.id) };
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/bank-cards/:cardId', scope: 'crm:write', tags, operationId: 'updateBankCard',
            summary: 'Sửa thẻ ngân hàng',
            params: s.object({ accountId: s.id(), cardId: s.int().min(1) }),
            body: s.object({
                bank_name: s.string().min(1).max(100).optional(),
                bin_bank: s.int().min(100000).max(999999).optional(),
                account_number: s.string().min(4).max(40).optional(),
                account_name: s.string().min(1).max(100).optional(),
                is_default: s.boolean().optional(),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const cur = ((await ctx.call('db:getBankCards', { zaloId: acc.id }))?.cards || []).find((c: any) => Number(c.id) === ctx.params.cardId);
                if (!cur) notFound(`thẻ ${ctx.params.cardId}`);
                const b = ctx.body;
                await ctx.call('db:upsertBankCard', {
                    zaloId: acc.id,
                    card: {
                        id: ctx.params.cardId,
                        bank_name: b.bank_name ?? cur.bank_name,
                        bin_bank: b.bin_bank ?? cur.bin_bank,
                        account_number: b.account_number ?? cur.account_number,
                        account_name: b.account_name ?? cur.account_name,
                        is_default: b.is_default === undefined ? (cur.is_default ? 1 : 0) : (b.is_default ? 1 : 0),
                    },
                });
                return { id: ctx.params.cardId };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/bank-cards/:cardId', scope: 'crm:write', tags, operationId: 'deleteBankCard',
            summary: 'Xoá thẻ ngân hàng đã lưu',
            params: s.object({ accountId: s.id(), cardId: s.int().min(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const cur = ((await ctx.call('db:getBankCards', { zaloId: acc.id }))?.cards || []).some((c: any) => Number(c.id) === ctx.params.cardId);
                if (!cur) notFound(`thẻ ${ctx.params.cardId}`);
                await ctx.call('db:deleteBankCard', { zaloId: acc.id, id: ctx.params.cardId });
                return { deleted: true };
            },
        }),
    ];
}
