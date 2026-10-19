/**
 * Chat mở rộng — thao tác hội thoại đồng bộ lên kênh, tải lịch sử cũ từ server, tin đặc biệt,
 * nhắc hẹn Zalo, danh sách nháp. Mirror đúng luồng UI:
 *  - ConversationList.tsx: handleTogglePin, handleMute/handleUnmute, handleMoveToOthers/handleRemoveFromOthers,
 *    handleMarkRead(asRead=false), handleDeleteConversation
 *  - ConversationList.tsx/ChatWindow.tsx: lấy tin cũ (telegramUser:getMessages, fb:fetchThreadMessages, zalo:getGroupChatHistory)
 *  - MessageInput.tsx: danh thiếp (zalo:sendCard), ghi âm (zalo:uploadVoiceFile → zalo:sendVoice); BankCardModal.tsx
 *  - ReminderPanel.tsx: zalo:getListReminder/createReminder/editReminder/removeReminder
 * Cờ hội thoại lưu như appStore.setMuted/addToOthers: tắt vô thời hạn = is_muted 1; có hạn = mute_until.
 */
import { s } from '../schema';
import { AccountInfo, ApiContext, ApiError, route, RouteDef } from '../types';
import { getCapability } from '../../../configs/channelConfig';
import { CHANNELS, buildQuotePayload, extractSentId, markRead, requireOnline, threadTypeNum, unsupported, zaloAuth } from '../channels/ChannelActions';
import { ChatRouteDeps, loadMessage, resolveAttachment, threadTypeOf } from './chat';
import { accountParams, scrub, threadParams, threadTypeSchema } from './common';

const TG_MUTE_FOREVER = 2147483647;

/** Như muteUntilToDuration (ConversationList.tsx): 0 = vô thời hạn (-1), 1h/4h/đến 8h sáng, còn lại số giây. */
export function zaloMuteDuration(until: number, now = Date.now()): number | string {
    if (until === 0) return -1;
    const remainSec = Math.round((until - now) / 1000);
    if (Math.abs(remainSec - 3600) <= 300) return 3600;
    if (Math.abs(remainSec - 14400) <= 300) return 14400;
    const t = new Date(until);
    if (t.getHours() === 8 && t.getMinutes() === 0) return 'until8AM';
    return remainSec > 0 ? remainSec : -1;
}

/** Cờ lưu DB như appStore.setMuted: vô thời hạn → is_muted=1; có hạn → mute_until=epoch. */
export function muteFlags(until: number): { is_muted: number; mute_until: number } {
    return until === 0 ? { is_muted: 1, mute_until: 0 } : { is_muted: 0, mute_until: until };
}

/** Đồng bộ lên kênh là phụ (UI cũng bỏ qua lỗi): trả true/false để bên gọi biết. */
async function trySync(fn: () => Promise<any>): Promise<boolean> {
    try { await fn(); return true; } catch { return false; }
}

const fileInput = s.object({
    upload_id: s.string().optional().describe('ID từ POST /media/uploads'),
    library_uuid: s.string().optional().describe('UUID item trong thư viện media'),
    url: s.string().format('uri').optional().describe('Link http/https công khai, server tự tải về'),
});

const REPEAT = ['none', 'daily', 'weekly', 'monthly'] as const;

function mapReminder(r: any): any {
    let params: any = r?.params;
    if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
    return {
        id: String(r?.id || r?.topicId || r?.reminderId || ''),
        title: params?.title || r?.title || '',
        emoji: r?.emoji || '⏰',
        start_time: Number(r?.startTime || 0),
        repeat: REPEAT[Number(r?.repeat) || 0] || 'none',
        creator_id: String(r?.creatorId || r?.creatorUid || ''),
        create_time: Number(r?.createTime || 0),
        edit_time: Number(r?.editTime || 0),
    };
}

function reminderList(raw: any): any[] {
    if (Array.isArray(raw)) return raw;
    return raw?.reminders || raw?.topics || raw?.data || [];
}

async function zaloThread(ctx: ApiContext, acc: AccountInfo, threadId: string, explicit?: 'user' | 'group') {
    requireOnline(acc);
    const auth = await zaloAuth(ctx, acc.id);
    const type = threadTypeNum(await threadTypeOf(ctx, acc.id, threadId, explicit));
    return { auth, type };
}

export function chatExtraRoutes(deps: ChatRouteDeps): RouteDef[] {
    const tags = ['Chat'];
    return [
        // ── Trạng thái hội thoại, đồng bộ lên kênh ─────────────────────────
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/unread', scope: 'chat:manage', tags, operationId: 'markConversationUnread',
            summary: 'Đánh dấu chưa đọc (đồng bộ lên Zalo)',
            description: 'Như menu "Đánh dấu chưa đọc": Zalo gắn dấu chưa đọc trên server (`zalo:addUnreadMark`). Bỏ dấu bằng `DELETE …/unread`.',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'đánh dấu chưa đọc');
                const { auth, type } = await zaloThread(ctx, acc, ctx.params.threadId);
                await ctx.call('zalo:addUnreadMark', { auth, threadId: ctx.params.threadId, type });
                return { unread: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId/unread', scope: 'chat:manage', tags, operationId: 'clearConversationUnread',
            summary: 'Bỏ đánh dấu chưa đọc (đã đọc + gỡ dấu trên Zalo)',
            description: 'Như menu "Đánh dấu đã đọc": đánh dấu đã đọc như `POST …/read`, Zalo gỡ thêm dấu chưa đọc trên server (`zalo:removeUnreadMark`).',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                const threadType = await threadTypeOf(ctx, acc.id, threadId);
                if (acc.channel === CHANNELS.ZALO && acc.online) {
                    await trySync(async () => ctx.call('zalo:removeUnreadMark', { auth: await zaloAuth(ctx, acc.id), threadId, type: threadTypeNum(threadType) }));
                }
                const last = await ctx.call('db:getMessages', { zaloId: acc.id, threadId, limit: 1 });
                await markRead(ctx, acc, threadId, threadType, (last?.messages || [])[0] || null);
                return { unread: false };
            },
        }),
        ...([true, false] as const).map(pin => route({
            method: pin ? 'POST' : 'DELETE', path: '/accounts/:accountId/conversations/:threadId/pin', scope: 'chat:manage', tags,
            operationId: pin ? 'pinConversation' : 'unpinConversation',
            summary: pin ? 'Ghim hội thoại (trên kênh nếu kênh hỗ trợ)' : 'Bỏ ghim hội thoại',
            description: 'Như menu "Ghim hội thoại": Zalo/Telegram ghim trên server (hiện ở mọi thiết bị); kênh không hỗ trợ thì ghim trong Deplao. `where` cho biết đã ghim ở đâu.',
            params: threadParams,
            handler: async (ctx: ApiContext) => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                if (!getCapability(acc.channel as any)?.supportsPinConversation) {
                    await ctx.call('db:setLocalPinnedConversation', { zaloId: acc.id, threadId, isPinned: pin });
                    return { pinned: pin, where: 'app' };
                }
                requireOnline(acc);
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    await ctx.call('telegramUser:setDialogPin', { accountId: acc.id, chatId: threadId, pinned: pin });
                } else {
                    const { auth, type } = await zaloThread(ctx, acc, threadId);
                    await ctx.call('zalo:setPinConversation', { auth, conversations: [{ threadId, type }], isPin: pin });
                }
                return { pinned: pin, where: 'channel' };
            },
        })),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/mute', scope: 'chat:manage', tags, operationId: 'muteConversation',
            summary: 'Tắt thông báo (lưu trong Deplao + đồng bộ lên Zalo/Telegram)',
            description: '`until` = epoch ms hết hạn; bỏ trống hoặc 0 = vô thời hạn. `synced` = đã đồng bộ lên kênh hay chưa (kênh không hỗ trợ / lỗi mạng vẫn tắt trong Deplao).',
            params: threadParams,
            body: s.object({ until: s.timestamp().default(0) }).optional(),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                const until = Number(ctx.body?.until) || 0;
                if (until && until <= Date.now()) throw new ApiError(400, 'VALIDATION_ERROR', '`until` phải ở tương lai (hoặc 0 = vô thời hạn)');
                await ctx.call('db:setContactFlags', { zaloId: acc.id, contactId: threadId, flags: muteFlags(until) });
                let synced = false;
                if (acc.online && acc.channel === CHANNELS.TELEGRAM_USER) {
                    synced = await trySync(() => ctx.call('telegramUser:setDialogMute', { accountId: acc.id, chatId: threadId, muteUntil: until === 0 ? TG_MUTE_FOREVER : Math.floor(until / 1000) }));
                } else if (acc.online && getCapability(acc.channel as any)?.supportsMuteSync) {
                    synced = await trySync(async () => {
                        const { auth, type } = await zaloThread(ctx, acc, threadId);
                        await ctx.call('zalo:setMute', { auth, threadId, threadType: type, duration: zaloMuteDuration(until), action: 1 });
                    });
                }
                return { muted: true, until, synced };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId/mute', scope: 'chat:manage', tags, operationId: 'unmuteConversation',
            summary: 'Bật lại thông báo',
            params: threadParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                await ctx.call('db:setContactFlags', { zaloId: acc.id, contactId: threadId, flags: { is_muted: 0, mute_until: 0 } });
                let synced = false;
                if (acc.online && acc.channel === CHANNELS.TELEGRAM_USER) {
                    synced = await trySync(() => ctx.call('telegramUser:setDialogMute', { accountId: acc.id, chatId: threadId, muteUntil: 0 }));
                } else if (acc.online && getCapability(acc.channel as any)?.supportsMuteSync) {
                    synced = await trySync(async () => {
                        const { auth, type } = await zaloThread(ctx, acc, threadId);
                        await ctx.call('zalo:setMute', { auth, threadId, threadType: type, action: 3 });
                    });
                }
                return { muted: false, synced };
            },
        }),
        ...([true, false] as const).map(into => route({
            method: into ? 'POST' : 'DELETE', path: '/accounts/:accountId/conversations/:threadId/others', scope: 'chat:manage', tags,
            operationId: into ? 'moveConversationToOthers' : 'moveConversationToMain',
            summary: into ? 'Chuyển vào thư mục "Khác" (tắt thông báo, Telegram: lưu trữ)' : 'Đưa về danh sách chính (bật thông báo)',
            params: threadParams,
            handler: async (ctx: ApiContext) => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                await ctx.call('db:setContactFlags', {
                    zaloId: acc.id, contactId: threadId,
                    flags: into ? { is_in_others: 1, ...muteFlags(0) } : { is_in_others: 0, is_muted: 0, mute_until: 0 },
                });
                let synced = false;
                if (acc.online && acc.channel === CHANNELS.TELEGRAM_USER) {
                    synced = await trySync(async () => {
                        await ctx.call('telegramUser:setDialogArchived', { accountId: acc.id, chatId: threadId, archived: into });
                        await ctx.call('telegramUser:setDialogMute', { accountId: acc.id, chatId: threadId, muteUntil: into ? TG_MUTE_FOREVER : 0 });
                    });
                } else if (acc.online && getCapability(acc.channel as any)?.supportsMuteSync) {
                    synced = await trySync(async () => {
                        const { auth, type } = await zaloThread(ctx, acc, threadId);
                        await ctx.call('zalo:setMute', into
                            ? { auth, threadId, threadType: type, duration: -1, action: 1 }
                            : { auth, threadId, threadType: type, action: 3 });
                    });
                }
                return { in_others: into, synced };
            },
        })),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId', scope: 'chat:manage', tags, operationId: 'deleteConversation',
            summary: 'Xoá hội thoại (toàn bộ tin trong Deplao; Zalo xoá cả trên server)',
            description: 'Không thể hoàn tác — bắt buộc `?confirm=true`. Như menu "Xóa hội thoại": Zalo gọi `zalo:deleteChat` theo tin cuối rồi xoá khỏi DB.',
            params: threadParams,
            query: s.object({ confirm: s.boolean().default(false).describe('Phải là true') }),
            handler: async ctx => {
                if (!ctx.query.confirm) throw new ApiError(400, 'VALIDATION_ERROR', 'Thêm ?confirm=true để xác nhận xoá hội thoại');
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                let channelDeleted = false;
                if (acc.channel === CHANNELS.ZALO && acc.online) {
                    channelDeleted = await trySync(async () => {
                        const last = (await ctx.call('db:getMessages', { zaloId: acc.id, threadId, limit: 1 }))?.messages?.[0];
                        if (!last) throw new Error('no message');
                        const { auth, type } = await zaloThread(ctx, acc, threadId);
                        await ctx.call('zalo:deleteChat', {
                            auth, threadId, type,
                            lastMessage: { ownerId: String(last.sender_id || ''), cliMsgId: String(last.cli_msg_id || last.msg_id || ''), globalMsgId: String(last.msg_id || '') },
                        });
                    });
                }
                await ctx.call('db:deleteConversation', { zaloId: acc.id, contactId: threadId });
                return { deleted: true, channel_deleted: channelDeleted };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/history/sync', scope: 'chat:read', tags, operationId: 'syncConversationHistory',
            summary: 'Tải tin cũ từ server của kênh vào Deplao',
            description: [
                'Lưu vào DB rồi đọc bằng `GET …/messages`. Telegram: `before_msg_id` = msg_id cũ nhất bạn đang có để lấy trang cũ hơn.',
                'Facebook: dùng `next_cursor` của lần trước làm `before_cursor`. Zalo: chỉ nhóm (Zalo không cho tải lịch sử chat 1-1).',
            ].join(' '),
            params: threadParams,
            body: s.object({
                limit: s.int().min(1).max(200).default(50),
                before_msg_id: s.string().max(64).optional(),
                before_cursor: s.string().max(500).optional(),
                topic_id: s.string().max(64).optional().describe('Telegram forum topic'),
            }).optional(),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                const limit = ctx.body?.limit ?? 50;
                requireOnline(acc);
                switch (acc.channel) {
                    case CHANNELS.TELEGRAM_USER: {
                        const raw = ctx.body?.before_msg_id ? String(ctx.body.before_msg_id).replace(/^tg_/, '') : '';
                        if (raw && !/^\d+$/.test(raw)) throw new ApiError(400, 'VALIDATION_ERROR', 'before_msg_id của Telegram là số');
                        const res = await ctx.call('telegramUser:getMessages', {
                            accountId: acc.id, chatId: threadId, limit,
                            ...(raw ? { offsetId: Number(raw) } : {}),
                            ...(ctx.body?.topic_id ? { topicRootMessageId: String(ctx.body.topic_id) } : {}),
                        }, { timeoutMs: 120_000 });
                        const fetched = Number(res?.messages?.length ?? res?.count ?? 0);
                        return { fetched, has_more: fetched >= limit, next_cursor: null };
                    }
                    case CHANNELS.FACEBOOK: {
                        const res = await ctx.call('fb:fetchThreadMessages', { accountId: acc.id, threadId, limit, beforeCursor: ctx.body?.before_cursor || null }, { timeoutMs: 120_000 });
                        return { fetched: Number(res?.messages?.length || 0), has_more: !!res?.cursor?.hasMore, next_cursor: res?.cursor?.before ?? null };
                    }
                    case CHANNELS.ZALO: {
                        if ((await threadTypeOf(ctx, acc.id, threadId)) !== 'group') return unsupported(acc, 'tải lịch sử chat 1-1 từ server');
                        const res = await ctx.call('zalo:getGroupChatHistory', { auth: await zaloAuth(ctx, acc.id), groupId: threadId, count: limit }, { timeoutMs: 120_000 });
                        if (res?.response?.error) throw new ApiError(502, 'UPSTREAM_ERROR', String(res.response.error));
                        return { fetched: Number(res?.response?.groupMsgsCount || 0), has_more: false, next_cursor: null };
                    }
                    default:
                        return unsupported(acc, 'tải lịch sử từ server');
                }
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/drafts', scope: 'chat:read', tags, operationId: 'listDrafts',
            summary: 'Mọi tin nháp đang soạn của tài khoản (mới sửa trước)',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const res = await ctx.call('db:getDrafts', { zaloId: acc.id });
                return (res?.drafts || []).map((d: any) => ({ thread_id: String(d.threadId), content: d.content || '', updated_at: Number(d.updatedAt) || 0 }));
            },
        }),

        // ── Tin đặc biệt ───────────────────────────────────────────────────
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/messages/contact-card', scope: 'chat:send', tags, operationId: 'sendContactCard',
            summary: 'Gửi danh thiếp (Zalo: theo user_id; Telegram bot: theo số điện thoại)',
            params: threadParams,
            body: s.object({
                user_id: s.id().optional().describe('Zalo: ID người được giới thiệu'),
                phone: s.string().max(30).optional().describe('Zalo: tuỳ chọn; Telegram bot: bắt buộc'),
                name: s.string().max(100).optional().describe('Telegram bot: tên hiển thị (bắt buộc)'),
                thread_type: threadTypeSchema.optional(),
                quote_msg_id: s.string().optional(),
            }),
            examples: { request: { user_id: '8412345678901234567', phone: '0912345678' } },
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                const b = ctx.body;
                if (acc.channel === CHANNELS.ZALO) {
                    if (!b.user_id) throw new ApiError(400, 'VALIDATION_ERROR', 'Zalo cần user_id');
                    const { auth, type } = await zaloThread(ctx, acc, threadId, b.thread_type);
                    const quote = b.quote_msg_id ? buildQuotePayload(await loadMessage(ctx, acc.id, threadId, b.quote_msg_id)) : null;
                    const res = await ctx.call('zalo:sendCard', {
                        auth, options: { userId: b.user_id, ...(b.phone ? { phoneNumber: b.phone } : {}) }, threadId, type, ...(quote ? { quote } : {}),
                    });
                    return extractSentId(res);
                }
                if (acc.channel === CHANNELS.TELEGRAM_BOT) {
                    if (!b.phone || !b.name) throw new ApiError(400, 'VALIDATION_ERROR', 'Telegram bot cần phone và name');
                    requireOnline(acc);
                    const [firstName, ...rest] = b.name.trim().split(/\s+/);
                    const res = await ctx.call('telegram:sendContact', { accountId: acc.id, chatId: threadId, phone: b.phone, firstName, lastName: rest.join(' ') || undefined });
                    return extractSentId(res);
                }
                return unsupported(acc, 'gửi danh thiếp');
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/messages/bank-card', scope: 'chat:send', tags, operationId: 'sendBankCard',
            summary: 'Gửi thẻ ngân hàng (Zalo) — thẻ đã lưu hoặc nhập trực tiếp',
            description: 'Truyền `bank_card_id` (từ GET /accounts/{accountId}/bank-cards) hoặc đủ `bin_bank`, `account_number`, `account_name`.',
            params: threadParams,
            body: s.object({
                bank_card_id: s.int().min(1).optional(),
                bin_bank: s.int().min(100000).max(999999).optional().describe('Mã BIN ngân hàng (6 số)'),
                account_number: s.string().min(4).max(40).optional(),
                account_name: s.string().min(1).max(100).optional(),
                thread_type: threadTypeSchema.optional(),
            }),
            examples: { request: { bin_bank: 970436, account_number: '0011001234567', account_name: 'NGUYEN VAN A' } },
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'gửi thẻ ngân hàng');
                let { bin_bank, account_number, account_name } = ctx.body;
                if (ctx.body.bank_card_id) {
                    const card = ((await ctx.call('db:getBankCards', { zaloId: acc.id }))?.cards || []).find((c: any) => Number(c.id) === ctx.body.bank_card_id);
                    if (!card) throw new ApiError(404, 'NOT_FOUND', `Không tìm thấy thẻ ${ctx.body.bank_card_id}`);
                    ({ bin_bank, account_number, account_name } = card);
                }
                if (!bin_bank || !account_number || !account_name) throw new ApiError(400, 'VALIDATION_ERROR', 'Cần bank_card_id hoặc đủ bin_bank, account_number, account_name');
                const { auth, type } = await zaloThread(ctx, acc, ctx.params.threadId, ctx.body.thread_type);
                const res = await ctx.call('zalo:sendBankCard', {
                    auth, payload: { binBank: Number(bin_bank), numAccBank: String(account_number), nameAccBank: String(account_name) },
                    threadId: ctx.params.threadId, type,
                });
                return extractSentId(res);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/messages/voice', scope: 'chat:send', tags, operationId: 'sendVoiceMessage',
            summary: 'Gửi tin nhắn thoại (Zalo, Telegram bot)',
            description: 'File âm thanh (m4a/mp3/ogg…) qua `upload_id`, `library_uuid` hoặc `url`. Zalo: upload rồi gửi dạng ghi âm như nút micro trong app. Kênh khác: gửi file âm thanh bằng POST …/messages.',
            params: threadParams,
            body: fileInput,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const threadId = ctx.params.threadId;
                if (acc.channel !== CHANNELS.ZALO && acc.channel !== CHANNELS.TELEGRAM_BOT) return unsupported(acc, 'tin nhắn thoại');
                const file = await resolveAttachment(ctx, deps, { upload_id: ctx.body.upload_id, library_uuid: ctx.body.library_uuid, url: ctx.body.url, kind: 'audio' });
                if (acc.channel === CHANNELS.TELEGRAM_BOT) {
                    requireOnline(acc);
                    return extractSentId(await ctx.call('telegram:sendVoice', { accountId: acc.id, chatId: threadId, voicePath: file.path }, { timeoutMs: 180_000 }));
                }
                const { auth, type } = await zaloThread(ctx, acc, threadId);
                const up = await ctx.call('zalo:uploadVoiceFile', { auth, voicePath: file.path, threadId, type }, { timeoutMs: 180_000 });
                const r = up?.response;
                const voiceUrl = r?.fileUrl || r?.normalUrl || r?.hdUrl || r?.url || r?.href || '';
                if (!voiceUrl) throw new ApiError(502, 'UPSTREAM_ERROR', 'Upload file ghi âm lên Zalo thất bại');
                return extractSentId(await ctx.call('zalo:sendVoice', { auth, options: { voiceUrl }, threadId, type }));
            },
        }),

        // ── Nhắc hẹn (Zalo) ────────────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/conversations/:threadId/reminders', scope: 'chat:read', tags, operationId: 'listReminders',
            summary: 'Nhắc hẹn trong hội thoại (Zalo)',
            params: threadParams,
            query: s.object({ limit: s.int().min(1).max(50).default(20) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'nhắc hẹn');
                const { auth, type } = await zaloThread(ctx, acc, ctx.params.threadId);
                const res = await ctx.call('zalo:getListReminder', { auth, options: { count: ctx.query.limit, lastId: '' }, threadId: ctx.params.threadId, type });
                return reminderList(res?.response).map(mapReminder);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/conversations/:threadId/reminders', scope: 'chat:manage', tags, operationId: 'createReminder',
            summary: 'Tạo nhắc hẹn (Zalo)',
            params: threadParams,
            body: s.object({
                title: s.string().min(1).max(200),
                start_time: s.timestamp().describe('Epoch ms, phải ở tương lai'),
                repeat: s.enum(REPEAT).default('none'),
                emoji: s.string().max(16).default('⏰'),
            }),
            examples: { request: { title: 'Gọi lại cho khách', start_time: 1767225600000, repeat: 'none' } },
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'nhắc hẹn');
                const b = ctx.body;
                if (b.start_time <= Date.now()) throw new ApiError(400, 'VALIDATION_ERROR', 'Thời gian nhắc hẹn phải ở trong tương lai');
                const { auth, type } = await zaloThread(ctx, acc, ctx.params.threadId);
                const res = await ctx.call('zalo:createReminder', {
                    auth,
                    options: { title: b.title, emoji: b.emoji, color: -1, startTime: b.start_time, repeat: REPEAT.indexOf(b.repeat), duration: -1, params: { title: b.title, setTitle: true } },
                    threadId: ctx.params.threadId, type,
                });
                return scrub(res?.response ?? null);
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/conversations/:threadId/reminders/:reminderId', scope: 'chat:manage', tags, operationId: 'updateReminder',
            summary: 'Sửa nhắc hẹn (Zalo)',
            params: s.object({ accountId: s.id(), threadId: s.id(), reminderId: s.id() }),
            body: s.object({
                title: s.string().min(1).max(200),
                start_time: s.timestamp(),
                repeat: s.enum(REPEAT).default('none'),
                emoji: s.string().max(16).default('⏰'),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'nhắc hẹn');
                const b = ctx.body;
                if (b.start_time <= Date.now()) throw new ApiError(400, 'VALIDATION_ERROR', 'Thời gian nhắc hẹn phải ở trong tương lai');
                const { auth, type } = await zaloThread(ctx, acc, ctx.params.threadId);
                const res = await ctx.call('zalo:editReminder', {
                    auth,
                    options: { topicId: ctx.params.reminderId, title: b.title, emoji: b.emoji, color: -1, startTime: b.start_time, repeat: REPEAT.indexOf(b.repeat), duration: -1, params: { title: b.title, setTitle: true } },
                    threadId: ctx.params.threadId, type,
                });
                return scrub(res?.response ?? null);
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/conversations/:threadId/reminders/:reminderId', scope: 'chat:manage', tags, operationId: 'deleteReminder',
            summary: 'Xoá nhắc hẹn (Zalo)',
            params: s.object({ accountId: s.id(), threadId: s.id(), reminderId: s.id() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'nhắc hẹn');
                const { auth, type } = await zaloThread(ctx, acc, ctx.params.threadId);
                await ctx.call('zalo:removeReminder', { auth, reminderId: ctx.params.reminderId, threadId: ctx.params.threadId, type });
                return { deleted: true };
            },
        }),
    ];
}
