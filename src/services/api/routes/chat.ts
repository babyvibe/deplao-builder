/**
 * Nhóm Chat — hội thoại và tin nhắn cho mọi kênh (Zalo, Facebook, Telegram).
 *
 * Đọc: db:getContactsFiltered, db:getContactById, db:getMessages, db:getMessageById,
 *       db:getMessagesAround, db:getMessagesByType, db:searchMessages, db:getMediaMessages,
 *       db:getFileMessages, db:getLinks, db:getPinnedMessages, db:getUnreadCount, db:getDraft.
 * Ghi: ChannelActions (mirror UI) + db:setLocalPinnedConversation, db:setContactFlags,
 *       db:setContactAlias, db:pinMessage/unpinMessage, db:upsertDraft/deleteDraft, db:deleteMessages.
 */
import * as fs from 'fs';
import { s } from '../schema';
import { AccountInfo, ApiContext, ApiError, FileContent, paged, route, RouteDef, RESPONSE_HANDLED } from '../types';
import { accountAllowed } from '../ApiAuth';
import * as actions from '../channels/ChannelActions';
import { CHANNELS, ThreadType, extractSentId, messageText } from '../channels/ChannelActions';
import { UploadStore, kindFromName } from '../UploadStore';
import { getApiSettingNumber } from '../settings';
import {
    accountParams, mapConversation, mapMessage, messageParams, notFound, offsetPage, pageShape, threadParams,
    threadTypeSchema, allowPrivateTargets,
} from './common';

export interface ChatRouteDeps {
    uploads: UploadStore;
}

const conversationSchema = s.object({
    thread_id: s.string(), account_id: s.string(), channel: s.string(), type: s.string(), display_name: s.string(),
    alias: s.string(), avatar_url: s.string(), phone: s.string(), is_friend: s.boolean(), unread_count: s.int(),
    last_message: s.string(), last_message_time: s.int(), is_muted: s.boolean(), mute_until: s.int(),
    is_in_others: s.boolean(), has_mention: s.boolean(),
});

const messageSchema = s.object({
    msg_id: s.string(), cli_msg_id: s.string().nullable(), account_id: s.string(), channel: s.string(),
    thread_id: s.string(), thread_type: s.string(), sender_id: s.string(), sender_name: s.string().nullable(),
    is_self: s.boolean(), msg_type: s.string(), content: s.string().describe('Nội dung gốc (có thể là JSON của kênh)'),
    text: s.string().describe('Văn bản thuần rút từ content'), timestamp: s.int(), status: s.string().nullable(),
    is_recalled: s.boolean(), is_edited: s.boolean(), topic_id: s.string().nullable(), reply_to_id: s.string().nullable(),
    attachments: s.array(s.any()), quote: s.any().nullable(), reactions: s.any(), has_local_media: s.boolean(),
    handled_by_employee: s.string().nullable(),
});

const mentionSchema = s.object({
    user_id: s.id(), offset: s.int().min(0), length: s.int().min(1),
});

const attachmentInput = s.object({
    upload_id: s.string().optional().describe('ID từ POST /media/uploads'),
    library_uuid: s.string().optional().describe('UUID item trong thư viện media'),
    url: s.string().format('uri').optional().describe('Link http/https công khai, server tự tải về (≤ giới hạn upload)'),
    kind: s.enum(['image', 'video', 'audio', 'file'] as const).optional().describe('Bỏ trống = tự nhận theo đuôi file'),
    caption: s.string().max(2000).optional(),
});

const sendBody = s.object({
    thread_type: threadTypeSchema.optional().describe('Bỏ trống = tự tra theo hội thoại'),
    text: s.string().max(10000).optional(),
    attachments: s.array(attachmentInput).max(10).optional(),
    sticker_id: s.union(s.string(), s.int()).optional(),
    link: s.object({ url: s.string().format('uri'), text: s.string().max(2000).optional() }).optional(),
    quote_msg_id: s.string().optional().describe('Trả lời tin nhắn này'),
    mentions: s.array(mentionSchema).max(50).optional(),
});

export async function threadTypeOf(ctx: ApiContext, accountId: string, threadId: string, explicit?: ThreadType): Promise<ThreadType> {
    if (explicit) return explicit;
    try {
        const res = await ctx.call('db:getContactById', { zaloId: accountId, contactId: threadId });
        return res?.contact?.contact_type === 'group' ? 'group' : 'user';
    } catch {
        return 'user';
    }
}

export async function loadMessage(ctx: ApiContext, accountId: string, threadId: string, msgId: string): Promise<any> {
    const res = await ctx.call('db:getMessageById', { zaloId: accountId, msgId, threadId });
    const row = res?.message;
    if (!row || String(row.thread_id) !== String(threadId)) notFound(`tin nhắn ${msgId}`);
    return row;
}

/** Đổi attachment input thành file trên máy (chỉ file do server tạo / thư viện được phép). */
export async function resolveAttachment(ctx: ApiContext, deps: ChatRouteDeps, a: any): Promise<{ path: string; name: string; kind: actions.FileKind; caption?: string }> {
    const principalId = `${ctx.principal.kind}:${ctx.principal.id}`;
    const given = [a.upload_id, a.library_uuid, a.url].filter(Boolean).length;
    if (given !== 1) throw new ApiError(400, 'VALIDATION_ERROR', 'Mỗi attachment cần đúng một trong upload_id, library_uuid, url');
    if (a.upload_id) {
        const rec = deps.uploads.get(a.upload_id, principalId);
        return { path: rec.path, name: rec.name, kind: (a.kind || rec.kind) as actions.FileKind, caption: a.caption };
    }
    if (a.library_uuid) {
        const res = await ctx.call('library:getItem', { uuid: a.library_uuid });
        const item = res?.item;
        if (!item) notFound(`item thư viện ${a.library_uuid}`);
        if (!accountAllowed(ctx.principal, String(item.owner_zalo_id))) {
            throw new ApiError(403, 'FORBIDDEN_ACCOUNT', 'Item thư viện thuộc tài khoản key không được cấp');
        }
        const p = String(item._localPath || '');
        if (!p || !fs.existsSync(p)) throw new ApiError(404, 'NOT_FOUND', 'File của item thư viện không còn trên máy');
        const kind = a.kind || (item.type === 'image' ? 'image' : item.type === 'video' ? 'video' : kindFromName(item.name || p));
        return { path: p, name: item.name || 'file', kind, caption: a.caption };
    }
    const maxBytes = Math.max(1, getApiSettingNumber('api_upload_max_mb')) * 1024 * 1024;
    const rec = await deps.uploads.saveFromUrl(a.url, principalId, maxBytes, { allowPrivate: allowPrivateTargets(ctx) });
    return { path: rec.path, name: rec.name, kind: (a.kind || rec.kind) as actions.FileKind, caption: a.caption };
}

export function chatRoutes(deps: ChatRouteDeps): RouteDef[] {
    const tags = ['Chat'];
    return [
        // ── Hội thoại ─────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/conversations', scope: 'chat:read', tags, operationId: 'listConversations',
            summary: 'Danh sách hội thoại, mới nhất trước',
            params: accountParams,
            query: s.object({
                ...pageShape,
                search: s.string().max(200).optional().describe('Tìm theo tên/số điện thoại'),
                unread_only: s.boolean().optional(),
                folder: s.enum(['all', 'main', 'others'] as const).default('all').describe('Zalo: hộp thư chính / khác'),
            }),
            response: s.array(conversationSchema),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { limit, offset, search, unread_only, folder } = ctx.query;
                const res = await ctx.call('db:getContactsFiltered', {
                    zaloId: acc.id,
                    search: search || undefined,
                    unreadOnly: !!unread_only,
                    othersOnly: folder === 'others',
                    excludeOthers: folder === 'main',
                    limit,
                    offset,
                });
                return offsetPage((res?.contacts || []).map(mapConversation), limit, offset);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId', scope: 'chat:read', tags, operationId: 'getConversation',
            summary: 'Một hội thoại kèm nhãn và trạng thái ghim',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:getContactById', { zaloId: acc.id, contactId: ctx.params.threadId });
                if (!res?.contact) notFound(`hội thoại ${ctx.params.threadId}`);
                const [labels, pins] = await Promise.all([
                    ctx.call('db:getThreadLocalLabels', { zaloId: acc.id, threadId: ctx.params.threadId }).catch(() => null),
                    ctx.call('db:getLocalPinnedConversations', { zaloId: acc.id }).catch(() => null),
                ]);
                return {
                    ...mapConversation(res.contact),
                    labels: labels?.labels || [],
                    pinned: (pins?.threadIds || []).map(String).includes(String(ctx.params.threadId)),
                };
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/conversations/:threadId', scope: 'chat:manage', tags, operationId: 'updateConversation',
            summary: 'Ghim, tắt thông báo, đặt biệt danh (trên Deplao)',
            description: 'Các cờ lưu trên Deplao như UI: ghim cục bộ (db:setLocalPinnedConversation), tắt thông báo (db:setContactFlags), biệt danh (db:setContactAlias).',
            params: threadParams,
            body: s.object({
                pinned: s.boolean().optional(),
                muted: s.boolean().optional(),
                mute_until: s.int().min(0).optional().describe('Epoch ms; 0 = vô thời hạn'),
                alias: s.string().max(100).optional(),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { pinned, muted, mute_until, alias } = ctx.body;
                if (pinned !== undefined) {
                    await ctx.call('db:setLocalPinnedConversation', { zaloId: acc.id, threadId: ctx.params.threadId, isPinned: pinned });
                }
                if (muted !== undefined) {
                    // Như appStore.setMuted: vô thời hạn → is_muted=1; có hạn → mute_until (is_muted=0).
                    const until = muted ? (mute_until || 0) : 0;
                    await ctx.call('db:setContactFlags', {
                        zaloId: acc.id, contactId: ctx.params.threadId,
                        flags: !muted ? { is_muted: 0, mute_until: 0 } : until ? { is_muted: 0, mute_until: until } : { is_muted: 1, mute_until: 0 },
                    });
                }
                if (alias !== undefined) {
                    await ctx.call('db:setContactAlias', { zaloId: acc.id, contactId: ctx.params.threadId, alias });
                }
                return { updated: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/unread-count', scope: 'chat:read', tags, operationId: 'getUnreadCount',
            summary: 'Tổng số tin chưa đọc của tài khoản',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:getUnreadCount', { zaloId: acc.id });
                return { total: Number(res?.total) || 0 };
            },
        }),

        // ── Tin nhắn ──────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/messages', scope: 'chat:read', tags, operationId: 'listMessages',
            summary: 'Tin nhắn của hội thoại, mới → cũ, phân trang bằng `before`',
            description: 'Trang sau: gọi lại với `before = pagination.next_before`. Tin cùng mốc thời gian có thể lặp ở ranh giới trang — khử trùng theo `msg_id`.',
            params: threadParams,
            query: s.object({
                limit: s.int().min(1).max(200).default(50),
                before: s.int().min(0).optional().describe('Chỉ lấy tin có timestamp <= before (epoch ms)'),
                topic_id: s.string().optional().describe('Telegram forum topic'),
                type: s.string().max(50).optional().describe('Lọc theo msg_type (vd: photo, file)'),
            }),
            response: s.array(messageSchema),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { limit, before, topic_id, type } = ctx.query;
                if (type) {
                    const res = await ctx.call('db:getMessagesByType', { zaloId: acc.id, threadId: ctx.params.threadId, msgType: type, limit });
                    const items = (res?.messages || []).map(mapMessage);
                    return paged(items, { limit, has_more: false, next_before: null });
                }
                const res = await ctx.call('db:getMessages', {
                    zaloId: acc.id, threadId: ctx.params.threadId, limit, before: before || 0, topicId: topic_id,
                });
                const items = (res?.messages || []).map(mapMessage);
                const oldest = items.length ? Math.min(...items.map((m: any) => m.timestamp)) : null;
                return paged(items, { limit, has_more: items.length >= limit, next_before: items.length >= limit ? oldest : null });
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId', scope: 'chat:read', tags, operationId: 'getMessage',
            summary: 'Một tin nhắn',
            params: messageParams,
            response: messageSchema,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                return mapMessage(await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId));
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId/around', scope: 'chat:read', tags, operationId: 'getMessagesAround',
            summary: 'Các tin xung quanh một tin (để mở lại ngữ cảnh)',
            params: messageParams,
            query: s.object({ limit: s.int().min(1).max(100).default(30) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                const res = await ctx.call('db:getMessagesAround', {
                    zaloId: acc.id, threadId: ctx.params.threadId, timestamp: row.timestamp, limit: ctx.query.limit,
                });
                return (res?.messages || []).map(mapMessage);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/messages/search', scope: 'chat:read', tags, operationId: 'searchMessages',
            summary: 'Tìm tin nhắn theo nội dung (full-text)',
            params: accountParams,
            query: s.object({
                q: s.string().min(1).max(200).describe('Từ khoá'),
                thread_id: s.string().optional().describe('Chỉ trong một hội thoại'),
                limit: s.int().min(1).max(200).default(50),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:searchMessages', { zaloId: acc.id, query: ctx.query.q });
                let rows: any[] = res?.results || [];
                if (ctx.query.thread_id) rows = rows.filter(r => String(r.thread_id) === String(ctx.query.thread_id));
                return rows.slice(0, ctx.query.limit).map(mapMessage);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/media', scope: 'chat:read', tags, operationId: 'listConversationMedia',
            summary: 'Ảnh/video, file hoặc link đã chia sẻ trong hội thoại',
            params: threadParams,
            query: s.object({ kind: s.enum(['media', 'file', 'link'] as const).default('media'), ...pageShape }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { kind, limit, offset } = ctx.query;
                const base = { zaloId: acc.id, threadId: ctx.params.threadId, limit, offset };
                if (kind === 'link') {
                    const res = await ctx.call('db:getLinks', base);
                    return offsetPage(res?.links || [], limit, offset);
                }
                const res = await ctx.call(kind === 'file' ? 'db:getFileMessages' : 'db:getMediaMessages', base);
                return offsetPage((res?.messages || []).map(mapMessage), limit, offset);
            },
        }),

        // ── Gửi ───────────────────────────────────────────────────────────
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/messages', scope: 'chat:send', tags, operationId: 'sendMessage',
            summary: 'Gửi tin: văn bản, file/ảnh/video, sticker, link (mọi kênh)',
            description: [
                'Gửi đúng như khi bấm gửi trên app (cùng handler IPC, cùng hàng đợi gửi). Thứ tự: attachments → sticker → link → text.',
                '',
                'File đính kèm KHÔNG nhận đường dẫn trên máy: dùng `upload_id` (POST /media/uploads), `library_uuid` hoặc `url` công khai.',
                'Video Zalo đi qua chuỗi getVideoMeta → uploadVideoThumb → uploadVideoFile → sendVideo như UI.',
                'Hỗ trợ header `Idempotency-Key` để gửi lại an toàn khi mất kết nối.',
            ].join('\n'),
            params: threadParams,
            body: sendBody,
            examples: {
                request: { text: 'Đơn #2291 đã giao, cảm ơn anh!', attachments: [{ upload_id: 'upl_8f1c...' }] },
                response: { channel: 'zalo', thread_id: '8899001122', sent: [{ type: 'file', msg_id: '7712', cli_msg_id: null }, { type: 'text', msg_id: '7713', cli_msg_id: '1760000000123' }] },
            },
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const b = ctx.body;
                if (!b.text && !(b.attachments?.length) && b.sticker_id === undefined && !b.link) {
                    throw new ApiError(400, 'VALIDATION_ERROR', 'Cần ít nhất một trong text, attachments, sticker_id, link');
                }
                actions.requireOnline(acc);
                const threadId = ctx.params.threadId;
                const threadType = await threadTypeOf(ctx, acc.id, threadId, b.thread_type);
                const quoteRow = b.quote_msg_id ? await loadMessage(ctx, acc.id, threadId, b.quote_msg_id) : undefined;
                const files = [];
                for (const a of b.attachments || []) files.push(await resolveAttachment(ctx, deps, a));

                const sent: any[] = [];
                for (const f of files) {
                    const res = await actions.sendFile(ctx, acc, { threadId, threadType, filePath: f.path, kind: f.kind, caption: f.caption, quoteRow });
                    sent.push({ type: f.kind, ...extractSentId(res) });
                }
                if (b.sticker_id !== undefined) {
                    const res = await actions.sendSticker(ctx, acc, threadId, threadType, b.sticker_id);
                    sent.push({ type: 'sticker', ...extractSentId(res) });
                }
                if (b.link) {
                    const res = await actions.sendLink(ctx, acc, threadId, threadType, b.link.url, b.link.text);
                    sent.push({ type: 'link', ...extractSentId(res) });
                }
                if (b.text) {
                    const res = await actions.sendText(ctx, acc, {
                        threadId, threadType, text: b.text, quoteRow: files.length ? undefined : quoteRow, mentions: b.mentions,
                    });
                    sent.push({ type: 'text', ...extractSentId(res) });
                }
                return { channel: acc.channel, thread_id: threadId, thread_type: threadType, sent };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId/forward', scope: 'chat:send', tags, operationId: 'forwardMessage',
            summary: 'Chuyển tiếp tin sang hội thoại khác (cùng tài khoản)',
            description: 'Hỗ trợ văn bản, ảnh, video, file (gửi lại từ file local như UI) và forward gốc của Facebook/Telegram. Loại khác trả 422.',
            params: messageParams,
            body: s.object({
                targets: s.array(s.object({ thread_id: s.id(), thread_type: threadTypeSchema.default('user') })).min(1).max(20),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                const results = await actions.forward(ctx, acc, row, ctx.body.targets);
                return { forwarded: ctx.body.targets.length, results: results.map(r => extractSentId(r)) };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId/reactions', scope: 'chat:send', tags, operationId: 'addReaction',
            summary: 'Thả reaction (emoji hoặc mã Zalo như HEART, LIKE)',
            params: messageParams,
            body: s.object({ emoji: s.string().min(1).max(32) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                await actions.react(ctx, acc, row, ctx.body.emoji);
                if (acc.channel !== CHANNELS.TELEGRAM_USER) {
                    await ctx.call('db:updateReaction', { zaloId: acc.id, msgId: row.msg_id, threadId: row.thread_id, userId: acc.id, emoji: ctx.body.emoji }).catch(() => null);
                }
                return { reacted: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId/reactions', scope: 'chat:send', tags, operationId: 'removeReaction',
            summary: 'Gỡ reaction của mình',
            params: messageParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                await actions.react(ctx, acc, row, null);
                return { removed: true };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId/recall', scope: 'chat:manage', tags, operationId: 'recallMessage',
            summary: 'Thu hồi tin (với mọi người) rồi đánh dấu đã thu hồi trong DB',
            params: messageParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                await actions.recall(ctx, acc, row);
                return { recalled: true };
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId', scope: 'chat:send', tags, operationId: 'editMessage',
            summary: 'Sửa nội dung tin đã gửi (Facebook, Telegram)',
            params: messageParams,
            body: s.object({ text: s.string().min(1).max(10000) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                await actions.editMessage(ctx, acc, row, ctx.body.text);
                return { edited: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId', scope: 'chat:manage', tags, operationId: 'deleteMessageForMe',
            summary: 'Xoá tin phía mình',
            description: 'Zalo: zalo:deleteMessage (onlyMe) rồi đánh dấu trong DB như UI. Kênh khác: chỉ xoá khỏi DB của Deplao.',
            params: messageParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                if (acc.channel === CHANNELS.ZALO) {
                    actions.requireOnline(acc);
                    const message = JSON.stringify({
                        data: { msgId: row.msg_id, cliMsgId: row.cli_msg_id || row.msg_id, uidFrom: row.sender_id },
                        threadId: row.thread_id,
                        type: row.thread_type,
                    });
                    await ctx.call('zalo:deleteMessage', { auth: await ctx.zaloAuth(acc.id), message, onlyMe: true });
                    await ctx.call('db:markMessageRecalled', { zaloId: acc.id, msgId: String(row.msg_id), threadId: String(row.thread_id) });
                } else {
                    await ctx.call('db:deleteMessages', { zaloId: acc.id, msgIds: [String(row.msg_id)], threadId: String(row.thread_id) });
                }
                return { deleted: true };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId/pin', scope: 'chat:manage', tags, operationId: 'pinMessage',
            summary: 'Ghim tin trong hội thoại',
            params: messageParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                if (acc.channel === CHANNELS.FACEBOOK && acc.online) {
                    await ctx.call('fb:pinMessage', { accountId: acc.id, messageId: String(row.msg_id), threadId: String(row.thread_id) });
                } else if (acc.channel === CHANNELS.TELEGRAM_USER && acc.online) {
                    await ctx.call('telegramUser:pinMessage', { accountId: acc.id, chatId: String(row.thread_id), messageId: String(row.msg_id).replace(/^tg_/, '') });
                }
                await ctx.call('db:pinMessage', {
                    zaloId: acc.id,
                    threadId: String(row.thread_id),
                    pin: {
                        msgId: String(row.msg_id), msgType: row.msg_type || 'text', content: row.content || '',
                        previewText: messageText(row).slice(0, 200), previewImage: '', senderId: String(row.sender_id || ''),
                        senderName: '', timestamp: Number(row.timestamp) || Date.now(),
                    },
                });
                return { pinned: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId/pin', scope: 'chat:manage', tags, operationId: 'unpinMessage',
            summary: 'Bỏ ghim tin',
            params: messageParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.FACEBOOK && acc.online) {
                    await ctx.call('fb:unpinMessage', { accountId: acc.id, messageId: ctx.params.msgId, threadId: ctx.params.threadId }).catch(() => null);
                } else if (acc.channel === CHANNELS.TELEGRAM_USER && acc.online) {
                    await ctx.call('telegramUser:pinMessage', { accountId: acc.id, chatId: ctx.params.threadId, messageId: ctx.params.msgId.replace(/^tg_/, ''), unpin: true }).catch(() => null);
                }
                await ctx.call('db:unpinMessage', { zaloId: acc.id, threadId: ctx.params.threadId, msgId: ctx.params.msgId });
                return { unpinned: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/pinned-messages', scope: 'chat:read', tags, operationId: 'listPinnedMessages',
            summary: 'Tin đã ghim của hội thoại',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:getPinnedMessages', { zaloId: acc.id, threadId: ctx.params.threadId });
                return res?.pins || [];
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/read', scope: 'chat:manage', tags, operationId: 'markConversationRead',
            summary: 'Đánh dấu đã đọc (DB + báo "đã xem" lên kênh)',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadType = await threadTypeOf(ctx, acc.id, ctx.params.threadId);
                const last = await ctx.call('db:getMessages', { zaloId: acc.id, threadId: ctx.params.threadId, limit: 1 });
                await actions.markRead(ctx, acc, ctx.params.threadId, threadType, (last?.messages || [])[0] || null);
                return { read: true };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/typing', scope: 'chat:send', tags, operationId: 'sendTyping',
            summary: 'Hiện trạng thái "đang gõ"',
            params: threadParams,
            body: s.object({ thread_type: threadTypeSchema.optional() }).optional(),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadType = await threadTypeOf(ctx, acc.id, ctx.params.threadId, ctx.body?.thread_type);
                await actions.typing(ctx, acc, ctx.params.threadId, threadType);
                return { typing: true };
            },
        }),

        // ── Nháp ──────────────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/draft', scope: 'chat:read', tags, operationId: 'getDraft',
            summary: 'Tin nháp đang soạn',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:getDraft', { zaloId: acc.id, threadId: ctx.params.threadId });
                return res?.draft ?? null;
            },
        }),
        route({
            method: 'PUT', path: '/accounts/:accountId/conversations/:threadId/draft', scope: 'chat:manage', tags, operationId: 'saveDraft',
            summary: 'Lưu tin nháp (hiện trong ô soạn của app)',
            params: threadParams,
            body: s.object({ content: s.string().max(10000) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await ctx.call('db:upsertDraft', { zaloId: acc.id, threadId: ctx.params.threadId, content: ctx.body.content });
                return { saved: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId/draft', scope: 'chat:manage', tags, operationId: 'deleteDraft',
            summary: 'Xoá tin nháp',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                await ctx.call('db:deleteDraft', { zaloId: acc.id, threadId: ctx.params.threadId });
                return { deleted: true };
            },
        }),

        // ── File đính kèm của tin ─────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/messages/:msgId/media', scope: 'media:read', tags: ['Media'], operationId: 'downloadMessageMedia',
            summary: 'Tải file/ảnh/video/ghi âm của một tin (tự tải về máy nếu chưa có)',
            params: messageParams,
            rawResponse: { contentType: 'application/octet-stream', description: 'Nội dung file', file: true },
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const row = await loadMessage(ctx, acc.id, ctx.params.threadId, ctx.params.msgId);
                // Ghi âm Zalo: app tự tải nền khi tin tới (EventBroadcaster) — gọi ngay sau tin thì có thể chưa xong → tải luôn.
                const kind: string = VOICE_MSG_TYPES.includes(String(row.msg_type || '')) ? 'voice' : actions.forwardKind(row);
                let filePath = '';
                try {
                    const lp = typeof row.local_paths === 'string' ? JSON.parse(row.local_paths || '{}') : (row.local_paths || {});
                    filePath = String(lp?.main || lp?.file || '');
                } catch { filePath = ''; }
                if (!filePath && acc.channel === CHANNELS.ZALO && (kind === 'image' || kind === 'video' || kind === 'file' || kind === 'voice')) {
                    const dl = await ctx.call('file:downloadMessageMedia', { zaloId: acc.id, msgId: String(row.msg_id), threadId: String(row.thread_id), kind }, { timeoutMs: 300_000 });
                    filePath = String(dl?.localPath || '');
                }
                if (!filePath) throw new ApiError(404, 'NOT_FOUND', 'Tin này không có file trên máy (hoặc link đã hết hạn)');
                return streamFile(ctx, filePath);
            },
        }),
    ];
}

/** Loại tin ghi âm (Zalo chat.voice; giống bộ lọc trigger). */
const VOICE_MSG_TYPES = ['chat.voice', 'voice', 'audio'];

function fmtMb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Stream file trên máy ra response. Đường dẫn tương đối (media/...) được resolve qua FileStorageService.
 * Gọi không qua HTTP với ctx.binary (plugin) → trả FileContent base64 (file lớn hơn maxBytes → 413).
 */
export async function streamFile(ctx: ApiContext, filePath: string, downloadName?: string): Promise<typeof RESPONSE_HANDLED | FileContent> {
    if (!ctx.raw && !ctx.binary) throw new ApiError(400, 'VALIDATION_ERROR', 'Chỉ tải được qua HTTP');
    let abs = filePath;
    try {
        const FileStorageService = require('../../file/FileStorageService').default;
        abs = FileStorageService.resolveAbsolutePath(filePath);
    } catch { /* test */ }
    if (!abs || !fs.existsSync(abs)) throw new ApiError(404, 'NOT_FOUND', 'File không còn trên máy');
    const stat = fs.statSync(abs);
    const name = downloadName || require('path').basename(abs);
    const { mimeFromName } = require('../UploadStore');
    if (!ctx.raw) {
        const maxBytes = ctx.binary!.maxBytes;
        if (stat.size > maxBytes) {
            throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `File ${fmtMb(stat.size)} lớn hơn giới hạn ${fmtMb(maxBytes)} khi đọc qua ứng dụng — tải qua HTTP API`);
        }
        const buf = await fs.promises.readFile(abs);
        return { name, mime: mimeFromName(name), size: buf.length, base64: buf.toString('base64') };
    }
    const res = ctx.raw.res;
    res.writeHead(200, {
        'Content-Type': mimeFromName(name),
        'Content-Length': String(stat.size),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=3600',
    });
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(abs);
        stream.on('error', reject);
        stream.on('end', () => resolve());
        stream.pipe(res);
    });
    return RESPONSE_HANDLED;
}

export function isAccountChannel(acc: AccountInfo, ...channels: string[]): boolean {
    return channels.includes(acc.channel);
}
