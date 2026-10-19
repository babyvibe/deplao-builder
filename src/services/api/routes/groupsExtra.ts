/**
 * Nhóm & Danh bạ mở rộng — quản trị nhóm, bình chọn, ghi chú nhóm, Telegram forum topic, chặn/biệt danh/gợi ý bạn.
 * Mirror UI: GroupInfoPanel.tsx (phó nhóm, chặn, duyệt thành viên, cài đặt nhóm, giải tán, ảnh nhóm),
 * CreatePollDialog.tsx / PollView.tsx, NoteViewModal.tsx, adapters/*.promoteMember|blockUser|setGroupAvatar,
 * ChatHeader.tsx (biệt danh), ConversationInfo.tsx (nhóm chung), FriendRequestBar.tsx, CRMRequestsTab.tsx,
 * crm/groups (link nhóm), ForumTopic* (Telegram).
 */
import { s } from '../schema';
import { AccountInfo, ApiContext, ApiError, route, RouteDef } from '../types';
import { CHANNELS, extractSentId, requireOnline, unsupported, zaloAuth } from '../channels/ChannelActions';
import { ChatRouteDeps, resolveAttachment } from './chat';
import { accountParams, scrub } from './common';

const groupParams = s.object({ accountId: s.id(), groupId: s.id().describe('ID nhóm (thread_id)') });
const memberParams = s.object({ accountId: s.id(), groupId: s.id(), userId: s.id() });
const userParams = s.object({ accountId: s.id(), userId: s.id().describe('ID người dùng trên kênh') });
const pollParams = s.object({ accountId: s.id(), pollId: s.id() });
const topicParams = s.object({ accountId: s.id(), groupId: s.id(), topicId: s.id().describe('ID topic (root message id)') });

/** Quyền admin khi Telegram bot nâng/hạ quản trị (giống TelegramBotAdapter.promoteMember). */
const TG_BOT_ADMIN = {
    canChangeInfo: true, canDeleteMessages: true, canInviteUsers: true,
    canRestrictMembers: true, canPinMessages: true, canManageVideoChats: true, canManageChat: true,
};
const TG_BOT_NO_ADMIN = {
    canChangeInfo: false, canDeleteMessages: false, canInviteUsers: false,
    canRestrictMembers: false, canPinMessages: false, canManageVideoChats: false, canManageChat: false, canPromoteMembers: false,
};

/** Cài đặt nhóm Zalo: tên API (snake_case) ↔ khoá zca-js. */
export const ZALO_GROUP_SETTINGS: Record<string, string> = {
    block_name: 'blockName',
    sign_admin_msg: 'signAdminMsg',
    set_topic_only: 'setTopicOnly',
    enable_msg_history: 'enableMsgHistory',
    join_approval: 'joinAppr',
    lock_create_post: 'lockCreatePost',
    lock_create_poll: 'lockCreatePoll',
    lock_send_msg: 'lockSendMsg',
    lock_view_member: 'lockViewMember',
};

export function mapZaloGroupSettings(setting: any): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [api, zalo] of Object.entries(ZALO_GROUP_SETTINGS)) out[api] = !!Number(setting?.[zalo] ?? 0);
    return out;
}

/** Nhóm chung: response getRelatedFriendGroup có nhiều dạng (như ConversationInfo.tsx). */
export function relatedGroupIds(raw: any, userId: string): string[] {
    if (raw?.groupRelateds && typeof raw.groupRelateds === 'object') {
        const val = raw.groupRelateds[userId] ?? raw.groupRelateds.all;
        if (Array.isArray(val)) return val.map(String);
        if (val && typeof val === 'object') return Object.keys(val);
        const first = Object.values(raw.groupRelateds)[0];
        if (Array.isArray(first)) return (first as any[]).map(String);
        return [];
    }
    if (Array.isArray(raw?.groupIds)) return raw.groupIds.map(String);
    return [];
}

async function zalo(ctx: ApiContext, acc: AccountInfo, channel: string, payload: Record<string, any>, timeoutMs?: number): Promise<any> {
    requireOnline(acc);
    const res = await ctx.call(channel, { auth: await zaloAuth(ctx, acc.id), ...payload }, timeoutMs ? { timeoutMs } : undefined);
    return res?.response ?? res;
}

function zaloOnly(acc: AccountInfo, action: string): void {
    if (acc.channel !== CHANNELS.ZALO) unsupported(acc, action);
}

function confirmRequired(ok: boolean, what: string): void {
    if (!ok) throw new ApiError(400, 'VALIDATION_ERROR', `Thao tác ${what} không thể hoàn tác — gửi kèm confirm=true`);
}

export function groupExtraRoutes(deps: ChatRouteDeps): RouteDef[] {
    const tags = ['Nhóm'];
    const ctags = ['Danh bạ'];
    return [
        // ── Quản trị nhóm ──────────────────────────────────────────────────
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/admins', scope: 'chat:manage', tags, operationId: 'addGroupAdmin',
            summary: 'Cấp quyền quản trị (Zalo: phó nhóm)',
            params: groupParams,
            body: s.object({ user_id: s.id() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { groupId } = ctx.params;
                const userId = ctx.body.user_id;
                switch (acc.channel) {
                    case CHANNELS.ZALO: await zalo(ctx, acc, 'zalo:addGroupDeputy', { userId, groupId }); break;
                    case CHANNELS.FACEBOOK: requireOnline(acc); await ctx.call('fb:addGroupAdmin', { accountId: acc.id, threadId: groupId, userId }); break;
                    case CHANNELS.TELEGRAM_USER: requireOnline(acc); await ctx.call('telegramUser:editChatAdmin', { accountId: acc.id, chatId: groupId, userId, isAdmin: true }); break;
                    case CHANNELS.TELEGRAM_BOT: requireOnline(acc); await ctx.call('telegram:promoteChatMember', { accountId: acc.id, chatId: groupId, userId, perms: TG_BOT_ADMIN }); break;
                    default: unsupported(acc, 'cấp quyền quản trị');
                }
                return { admin: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/groups/:groupId/admins/:userId', scope: 'chat:manage', tags, operationId: 'removeGroupAdmin',
            summary: 'Gỡ quyền quản trị',
            params: memberParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { groupId, userId } = ctx.params;
                switch (acc.channel) {
                    case CHANNELS.ZALO: await zalo(ctx, acc, 'zalo:removeGroupDeputy', { userId, groupId }); break;
                    case CHANNELS.FACEBOOK: requireOnline(acc); await ctx.call('fb:removeGroupAdmin', { accountId: acc.id, threadId: groupId, userId }); break;
                    case CHANNELS.TELEGRAM_USER: requireOnline(acc); await ctx.call('telegramUser:editChatAdmin', { accountId: acc.id, chatId: groupId, userId, isAdmin: false }); break;
                    case CHANNELS.TELEGRAM_BOT: requireOnline(acc); await ctx.call('telegram:promoteChatMember', { accountId: acc.id, chatId: groupId, userId, perms: TG_BOT_NO_ADMIN }); break;
                    default: unsupported(acc, 'gỡ quyền quản trị');
                }
                return { admin: false };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/owner', scope: 'chat:manage', tags, operationId: 'transferGroupOwner',
            summary: 'Chuyển quyền trưởng nhóm (Zalo)',
            description: 'Bạn sẽ mất quyền trưởng nhóm — bắt buộc `confirm: true`.',
            params: groupParams,
            body: s.object({ user_id: s.id(), confirm: s.boolean().default(false) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'chuyển trưởng nhóm');
                confirmRequired(ctx.body.confirm, 'chuyển trưởng nhóm');
                await zalo(ctx, acc, 'zalo:changeGroupOwner', { userId: ctx.body.user_id, groupId: ctx.params.groupId });
                return { owner_id: ctx.body.user_id };
            },
        }),
        route({
            method: 'PUT', path: '/accounts/:accountId/groups/:groupId/avatar', scope: 'chat:manage', tags, operationId: 'setGroupAvatar',
            summary: 'Đổi ảnh nhóm (Zalo, Telegram)',
            params: groupParams,
            body: s.object({
                upload_id: s.string().optional(),
                library_uuid: s.string().optional(),
                url: s.string().format('uri').optional(),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { groupId } = ctx.params;
                if (![CHANNELS.ZALO, CHANNELS.TELEGRAM_USER, CHANNELS.TELEGRAM_BOT].includes(acc.channel as any)) return unsupported(acc, 'đổi ảnh nhóm');
                const file = await resolveAttachment(ctx, deps, { ...ctx.body, kind: 'image' });
                if (!/\.(jpe?g|png|webp|gif|bmp)$/i.test(file.name)) throw new ApiError(400, 'VALIDATION_ERROR', 'Ảnh nhóm phải là file ảnh (jpg, png, webp…)');
                if (acc.channel === CHANNELS.ZALO) await zalo(ctx, acc, 'zalo:changeGroupAvatar', { avatarPath: file.path, groupId }, 120_000);
                else if (acc.channel === CHANNELS.TELEGRAM_USER) { requireOnline(acc); await ctx.call('telegramUser:editChatPhoto', { accountId: acc.id, chatId: groupId, photoPath: file.path }, { timeoutMs: 120_000 }); }
                else { requireOnline(acc); await ctx.call('telegram:setChatPhoto', { accountId: acc.id, chatId: groupId, photoPath: file.path }, { timeoutMs: 120_000 }); }
                return { updated: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/groups/:groupId/settings', scope: 'chat:read', tags, operationId: 'getGroupSettings',
            summary: 'Cài đặt nhóm Zalo (khoá đổi tên, duyệt thành viên, chỉ admin nhắn…)',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'cài đặt nhóm');
                const info = await zalo(ctx, acc, 'zalo:getGroupInfo', { groupId: ctx.params.groupId });
                return mapZaloGroupSettings(info?.gridInfoMap?.[ctx.params.groupId]?.setting);
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/groups/:groupId/settings', scope: 'chat:manage', tags, operationId: 'updateGroupSettings',
            summary: 'Sửa cài đặt nhóm (Zalo; Facebook: chỉ join_approval)',
            description: 'Chỉ gửi trường cần đổi; các cài đặt khác giữ nguyên (đọc cài đặt hiện tại trước, như bật/tắt từng mục trong app).',
            params: groupParams,
            body: s.object(Object.fromEntries(Object.keys(ZALO_GROUP_SETTINGS).map(k => [k, s.boolean().optional()])) as Record<string, any>),
            examples: { request: { join_approval: true, lock_send_msg: false } },
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { groupId } = ctx.params;
                const changes = Object.entries(ctx.body || {}).filter(([, v]) => typeof v === 'boolean') as Array<[string, boolean]>;
                if (!changes.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Không có cài đặt nào để đổi');
                if (acc.channel === CHANNELS.FACEBOOK) {
                    if (changes.some(([k]) => k !== 'join_approval')) throw new ApiError(422, 'CHANNEL_UNSUPPORTED', 'Facebook chỉ hỗ trợ join_approval');
                    requireOnline(acc);
                    await ctx.call('fb:changeApprovalMode', { accountId: acc.id, threadId: groupId, approved: changes[0][1] });
                    return { join_approval: changes[0][1] };
                }
                zaloOnly(acc, 'cài đặt nhóm');
                const info = await zalo(ctx, acc, 'zalo:getGroupInfo', { groupId });
                const current = { ...(info?.gridInfoMap?.[groupId]?.setting || {}) };
                const next = { ...current };
                for (const [k, v] of changes) next[ZALO_GROUP_SETTINGS[k]] = v ? 1 : 0;
                await zalo(ctx, acc, 'zalo:updateGroupSettings', { settings: JSON.stringify(next), groupId, oldSettings: JSON.stringify(current) });
                return mapZaloGroupSettings(next);
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/groups/:groupId', scope: 'chat:manage', tags, operationId: 'disbandGroup',
            summary: 'Giải tán nhóm (Zalo, cần là trưởng nhóm)',
            description: 'Không thể hoàn tác — bắt buộc `?confirm=true`.',
            params: groupParams,
            query: s.object({ confirm: s.boolean().default(false) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'giải tán nhóm');
                confirmRequired(ctx.query.confirm, 'giải tán nhóm');
                await zalo(ctx, acc, 'zalo:disperseGroup', { groupId: ctx.params.groupId });
                return { disbanded: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/groups/:groupId/pending-members', scope: 'chat:read', tags, operationId: 'listPendingGroupMembers',
            summary: 'Người xin vào nhóm đang chờ duyệt (Zalo)',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'duyệt thành viên');
                const res = await zalo(ctx, acc, 'zalo:getPendingGroupMembers', { groupId: ctx.params.groupId });
                return (res?.users || []).map((u: any) => ({
                    user_id: String(u.uid || u.id || u.userId || u),
                    display_name: u.dpn || u.displayName || u.name || '',
                    avatar_url: u.avatar || u.avt || '',
                })).filter((u: any) => u.user_id);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/pending-members/review', scope: 'chat:manage', tags, operationId: 'reviewPendingGroupMembers',
            summary: 'Duyệt hoặc từ chối người xin vào nhóm (Zalo, Facebook)',
            description: 'Xử lý lần lượt từng người như nút "Duyệt tất cả" trong app; `results` cho biết từng người thành công hay lỗi.',
            params: groupParams,
            body: s.object({ user_ids: s.array(s.id()).min(1).max(100), approve: s.boolean() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { groupId } = ctx.params;
                if (acc.channel !== CHANNELS.ZALO && acc.channel !== CHANNELS.FACEBOOK) return unsupported(acc, 'duyệt thành viên');
                requireOnline(acc);
                const auth = acc.channel === CHANNELS.ZALO ? await zaloAuth(ctx, acc.id) : null;
                const results: Array<{ user_id: string; ok: boolean; error?: string }> = [];
                for (const userId of ctx.body.user_ids) {
                    try {
                        if (auth) await ctx.call('zalo:reviewPendingMemberRequest', { auth, groupId, payload: { members: userId, isApprove: ctx.body.approve } });
                        else await ctx.call('fb:approvePendingMember', { accountId: acc.id, threadId: groupId, userId, approve: ctx.body.approve });
                        results.push({ user_id: userId, ok: true });
                    } catch (err: any) {
                        results.push({ user_id: userId, ok: false, error: err?.message || String(err) });
                    }
                }
                return { approved: ctx.body.approve, results };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/groups/:groupId/blocked-members', scope: 'chat:read', tags, operationId: 'listBlockedGroupMembers',
            summary: 'Thành viên bị chặn khỏi nhóm (Zalo)',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'danh sách chặn của nhóm');
                return scrub(await zalo(ctx, acc, 'zalo:getGroupBlockedMember', { groupId: ctx.params.groupId }));
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/blocked-members', scope: 'chat:manage', tags, operationId: 'blockGroupMember',
            summary: 'Chặn thành viên khỏi nhóm (Zalo; Telegram/Facebook: mời ra)',
            params: groupParams,
            body: s.object({ user_id: s.id() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { groupId } = ctx.params;
                const userId = ctx.body.user_id;
                switch (acc.channel) {
                    case CHANNELS.ZALO: await zalo(ctx, acc, 'zalo:addGroupBlockedMember', { userId, groupId }); break;
                    case CHANNELS.TELEGRAM_USER: requireOnline(acc); await ctx.call('telegramUser:deleteChatUser', { accountId: acc.id, chatId: groupId, userId }); break;
                    case CHANNELS.TELEGRAM_BOT: requireOnline(acc); await ctx.call('telegram:banChatMember', { accountId: acc.id, chatId: groupId, userId }); break;
                    default: unsupported(acc, 'chặn thành viên nhóm');
                }
                return { blocked: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/groups/:groupId/blocked-members/:userId', scope: 'chat:manage', tags, operationId: 'unblockGroupMember',
            summary: 'Bỏ chặn thành viên nhóm (Zalo, Telegram bot)',
            params: memberParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { groupId, userId } = ctx.params;
                if (acc.channel === CHANNELS.ZALO) await zalo(ctx, acc, 'zalo:removeGroupBlockedMember', { userId, groupId });
                else if (acc.channel === CHANNELS.TELEGRAM_BOT) { requireOnline(acc); await ctx.call('telegram:unbanChatMember', { accountId: acc.id, chatId: groupId, userId }); }
                else unsupported(acc, 'bỏ chặn thành viên nhóm');
                return { blocked: false };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/group-links/info', scope: 'chat:read', tags, operationId: 'getGroupLinkInfo',
            summary: 'Xem nhóm từ link mời (Zalo): tên, số thành viên, trang thành viên',
            params: accountParams,
            query: s.object({ link: s.string().min(8).max(300).describe('vd https://zalo.me/g/abcxyz'), page: s.int().min(1).max(500).default(1) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'xem link nhóm');
                return scrub(await zalo(ctx, acc, 'zalo:getGroupLinkInfo', { link: ctx.query.link, memberPage: ctx.query.page }));
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/group-links/join', scope: 'chat:manage', tags, operationId: 'joinGroupByLink',
            summary: 'Vào nhóm bằng link mời (Zalo) hoặc username/ID (Telegram)',
            params: accountParams,
            body: s.object({ link: s.string().min(3).max(300).describe('Zalo: link zalo.me/g/…; Telegram: @username hoặc ID nhóm công khai') }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.ZALO) return scrub(await zalo(ctx, acc, 'zalo:joinGroupLink', { link: ctx.body.link }));
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    requireOnline(acc);
                    const chatId = ctx.body.link.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
                    const r = await ctx.call('telegramUser:joinGroup', { accountId: acc.id, chatId });
                    return { joined: !r?.requested, requested: !!r?.requested, info: scrub(r?.info ?? null) };
                }
                return unsupported(acc, 'vào nhóm bằng link');
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/users/:userId/invite-to-groups', scope: 'chat:manage', tags, operationId: 'inviteUserToGroups',
            summary: 'Mời một người vào nhiều nhóm (Zalo)',
            params: userParams,
            body: s.object({ group_ids: s.array(s.id()).min(1).max(50) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'mời vào nhóm');
                return scrub(await zalo(ctx, acc, 'zalo:inviteUserToGroups', { userId: ctx.params.userId, groupIds: ctx.body.group_ids }));
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/users/:userId/mutual-groups', scope: 'contacts:read', tags: ctags, operationId: 'listMutualGroups',
            summary: 'Nhóm chung với một người (Zalo)',
            params: userParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'nhóm chung');
                const raw = await zalo(ctx, acc, 'zalo:getRelatedFriendGroup', { userId: ctx.params.userId });
                return { group_ids: relatedGroupIds(raw, ctx.params.userId) };
            },
        }),

        // ── Bình chọn ──────────────────────────────────────────────────────
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/polls', scope: 'chat:send', tags, operationId: 'createPoll',
            summary: 'Tạo bình chọn trong nhóm (Zalo, Facebook, Telegram bot)',
            description: 'Các tuỳ chọn multiple/allow_add_option/hide_vote_preview/anonymous/expires_at chỉ áp dụng cho Zalo.',
            params: groupParams,
            body: s.object({
                question: s.string().min(1).max(300),
                options: s.array(s.string().min(1).max(200)).min(2).max(20),
                multiple: s.boolean().default(false),
                allow_add_option: s.boolean().default(true),
                hide_vote_preview: s.boolean().default(false),
                anonymous: s.boolean().default(false),
                expires_at: s.timestamp().optional().describe('Epoch ms; bỏ trống = không hết hạn'),
            }),
            examples: { request: { question: 'Chốt lịch họp tuần sau?', options: ['Thứ 3', 'Thứ 5'], multiple: false } },
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const b = ctx.body;
                const { groupId } = ctx.params;
                if (b.expires_at && b.expires_at <= Date.now()) throw new ApiError(400, 'VALIDATION_ERROR', 'expires_at phải ở tương lai');
                switch (acc.channel) {
                    case CHANNELS.ZALO:
                        return scrub(await zalo(ctx, acc, 'zalo:createPoll', {
                            options: {
                                question: b.question, options: b.options, expiredTime: b.expires_at || 0,
                                allowMultiChoices: b.multiple, allowAddNewOption: b.allow_add_option, hideVotePreview: b.hide_vote_preview, isAnonymous: b.anonymous,
                            },
                            groupId,
                        }));
                    case CHANNELS.FACEBOOK:
                        requireOnline(acc);
                        return scrub(await ctx.call('fb:createPoll', { accountId: acc.id, threadId: groupId, question: b.question, options: b.options }));
                    case CHANNELS.TELEGRAM_BOT:
                        requireOnline(acc);
                        return extractSentId(await ctx.call('telegram:sendPoll', { accountId: acc.id, chatId: groupId, question: b.question, options: b.options }));
                    default:
                        return unsupported(acc, 'tạo bình chọn');
                }
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/polls/:pollId', scope: 'chat:read', tags, operationId: 'getPoll',
            summary: 'Chi tiết bình chọn: lựa chọn, số phiếu, người bình chọn (Zalo)',
            params: pollParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'xem bình chọn');
                return scrub(await zalo(ctx, acc, 'zalo:getPollDetail', { pollId: ctx.params.pollId }));
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/polls/:pollId/votes', scope: 'chat:send', tags, operationId: 'votePoll',
            summary: 'Bình chọn (Zalo, Facebook). Mảng rỗng = huỷ bình chọn (Zalo)',
            params: pollParams,
            body: s.object({ option_ids: s.array(s.union(s.int(), s.string().max(64))).max(20) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const ids = ctx.body.option_ids;
                if (acc.channel === CHANNELS.ZALO) {
                    if (!/^\d+$/.test(ctx.params.pollId) || ids.some((x: any) => !/^\d+$/.test(String(x)))) throw new ApiError(400, 'VALIDATION_ERROR', 'Zalo: pollId và option_ids là số');
                    await zalo(ctx, acc, 'zalo:doVotePoll', { pollId: Number(ctx.params.pollId), optionIds: ids.map(Number) });
                } else if (acc.channel === CHANNELS.FACEBOOK) {
                    requireOnline(acc);
                    await ctx.call('fb:votePoll', { accountId: acc.id, pollId: ctx.params.pollId, optionIds: ids.map(String) });
                } else {
                    return unsupported(acc, 'bình chọn');
                }
                return { voted: ids.length > 0 };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/polls/:pollId/lock', scope: 'chat:manage', tags, operationId: 'lockPoll',
            summary: 'Khoá bình chọn (Zalo, người tạo)',
            params: pollParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'khoá bình chọn');
                if (!/^\d+$/.test(ctx.params.pollId)) throw new ApiError(400, 'VALIDATION_ERROR', 'pollId là số');
                await zalo(ctx, acc, 'zalo:lockPoll', { pollId: Number(ctx.params.pollId) });
                return { locked: true };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/polls/:pollId/options', scope: 'chat:send', tags, operationId: 'addPollOption',
            summary: 'Thêm lựa chọn vào bình chọn (Zalo)',
            params: pollParams,
            body: s.object({ option: s.string().min(1).max(200) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'thêm lựa chọn');
                if (!/^\d+$/.test(ctx.params.pollId)) throw new ApiError(400, 'VALIDATION_ERROR', 'pollId là số');
                return scrub(await zalo(ctx, acc, 'zalo:addPollOption', { pollId: Number(ctx.params.pollId), option: ctx.body.option }));
            },
        }),

        // ── Ghi chú nhóm (Zalo) ───────────────────────────────────────────
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/notes', scope: 'chat:send', tags, operationId: 'createGroupNote',
            summary: 'Tạo ghi chú nhóm (Zalo), tuỳ chọn ghim lên đầu',
            params: groupParams,
            body: s.object({ title: s.string().min(1).max(2000), pin: s.boolean().default(false) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'ghi chú nhóm');
                return scrub(await zalo(ctx, acc, 'zalo:createNote', { groupId: ctx.params.groupId, title: ctx.body.title, pinAct: ctx.body.pin }));
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/groups/:groupId/notes/:noteId', scope: 'chat:send', tags, operationId: 'updateGroupNote',
            summary: 'Sửa ghi chú nhóm (Zalo)',
            params: s.object({ accountId: s.id(), groupId: s.id(), noteId: s.id().describe('topicId của ghi chú') }),
            body: s.object({ title: s.string().min(1).max(2000), pin: s.boolean().default(true) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'ghi chú nhóm');
                return scrub(await zalo(ctx, acc, 'zalo:editNote', { groupId: ctx.params.groupId, topicId: ctx.params.noteId, title: ctx.body.title, pinAct: ctx.body.pin }));
            },
        }),

        // ── Telegram forum topic ───────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/groups/:groupId/topics', scope: 'chat:read', tags, operationId: 'listForumTopics',
            summary: 'Chủ đề (forum topic) của siêu nhóm Telegram',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.TELEGRAM_USER) return unsupported(acc, 'forum topic');
                requireOnline(acc);
                return scrub((await ctx.call('telegramUser:getForumTopics', { accountId: acc.id, chatId: ctx.params.groupId }))?.topics || []);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/topics', scope: 'chat:manage', tags, operationId: 'createForumTopic',
            summary: 'Tạo chủ đề (Telegram)',
            params: groupParams,
            body: s.object({ title: s.string().min(1).max(128), icon_color: s.int().min(0).max(0xffffff).optional(), icon_emoji_id: s.string().max(64).optional() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.TELEGRAM_USER) return unsupported(acc, 'forum topic');
                requireOnline(acc);
                const r = await ctx.call('telegramUser:createForumTopic', {
                    accountId: acc.id, chatId: ctx.params.groupId, title: ctx.body.title, iconColor: ctx.body.icon_color, iconEmojiId: ctx.body.icon_emoji_id,
                });
                return { topic_id: r?.topicId ?? null };
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/groups/:groupId/topics/:topicId', scope: 'chat:manage', tags, operationId: 'updateForumTopic',
            summary: 'Sửa / đóng / ghim chủ đề (Telegram)',
            params: topicParams,
            body: s.object({ title: s.string().min(1).max(128).optional(), icon_emoji_id: s.string().max(64).optional(), closed: s.boolean().optional(), pinned: s.boolean().optional() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.TELEGRAM_USER) return unsupported(acc, 'forum topic');
                requireOnline(acc);
                const b = ctx.body;
                await ctx.call('telegramUser:editForumTopic', {
                    accountId: acc.id, chatId: ctx.params.groupId, topicRootMessageId: ctx.params.topicId,
                    ...(b.title !== undefined ? { title: b.title } : {}),
                    ...(b.icon_emoji_id !== undefined ? { iconEmojiId: b.icon_emoji_id } : {}),
                    ...(b.closed !== undefined ? { closed: b.closed } : {}),
                    ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
                });
                return { updated: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/groups/:groupId/topics/:topicId/messages', scope: 'chat:read', tags, operationId: 'listForumTopicMessages',
            summary: 'Tin mới nhất của một chủ đề, lấy trực tiếp từ Telegram',
            description: 'Tin đã lưu trong Deplao đọc bằng `GET …/conversations/{groupId}/messages?topic_id=`.',
            params: topicParams,
            query: s.object({ limit: s.int().min(1).max(100).default(50) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.TELEGRAM_USER) return unsupported(acc, 'forum topic');
                requireOnline(acc);
                const r = await ctx.call('telegramUser:getForumTopicMessages', { accountId: acc.id, chatId: ctx.params.groupId, topicRootMessageId: ctx.params.topicId, limit: ctx.query.limit });
                return scrub(r?.messages || []);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/topics/:topicId/messages', scope: 'chat:send', tags, operationId: 'sendForumTopicMessage',
            summary: 'Gửi tin vào chủ đề (Telegram): chữ hoặc một file',
            params: topicParams,
            body: s.object({
                text: s.string().max(4096).optional().describe('Chữ; khi gửi kèm file thì là chú thích'),
                upload_id: s.string().optional(),
                library_uuid: s.string().optional(),
                url: s.string().format('uri').optional(),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.TELEGRAM_USER) return unsupported(acc, 'forum topic');
                requireOnline(acc);
                const b = ctx.body;
                const base = { accountId: acc.id, chatId: ctx.params.groupId, topicRootMessageId: ctx.params.topicId };
                if (b.upload_id || b.library_uuid || b.url) {
                    const file = await resolveAttachment(ctx, deps, { upload_id: b.upload_id, library_uuid: b.library_uuid, url: b.url });
                    return extractSentId(await ctx.call('telegramUser:sendTopicFile', { ...base, filePath: file.path, caption: b.text || '' }, { timeoutMs: 300_000 }));
                }
                if (!b.text) throw new ApiError(400, 'VALIDATION_ERROR', 'Cần text hoặc một file');
                return extractSentId(await ctx.call('telegramUser:sendTopicMessage', { ...base, text: b.text }));
            },
        }),

        // ── Danh bạ ────────────────────────────────────────────────────────
        ...([true, false] as const).map(block => route({
            method: block ? 'POST' : 'DELETE', path: '/accounts/:accountId/users/:userId/block', scope: 'contacts:write', tags: ctags,
            operationId: block ? 'blockUser' : 'unblockUser',
            summary: block ? 'Chặn người dùng (Zalo, Facebook, Telegram)' : 'Bỏ chặn người dùng',
            params: userParams,
            handler: async (ctx: ApiContext) => {
                const acc = await ctx.account(ctx.params.accountId);
                const userId = ctx.params.userId;
                switch (acc.channel) {
                    case CHANNELS.ZALO: await zalo(ctx, acc, block ? 'zalo:blockUser' : 'zalo:unblockUser', { userId }); break;
                    case CHANNELS.FACEBOOK: requireOnline(acc); await ctx.call(block ? 'fb:blockUser' : 'fb:unblockUser', { accountId: acc.id, userId }); break;
                    case CHANNELS.TELEGRAM_USER: requireOnline(acc); await ctx.call(block ? 'telegramUser:blockUser' : 'telegramUser:unblockUser', { accountId: acc.id, userId }); break;
                    default: unsupported(acc, block ? 'chặn người dùng' : 'bỏ chặn');
                }
                return { blocked: block };
            },
        })),
        route({
            method: 'PUT', path: '/accounts/:accountId/users/:userId/alias', scope: 'contacts:write', tags: ctags, operationId: 'setUserAlias',
            summary: 'Đặt tên gợi nhớ (Zalo: đồng bộ lên Zalo; kênh khác: lưu trong Deplao)',
            params: userParams,
            body: s.object({ alias: s.string().max(100).describe('Chuỗi rỗng = xoá tên gợi nhớ') }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const alias = ctx.body.alias.trim();
                let synced = false;
                if (acc.channel === CHANNELS.ZALO) {
                    await zalo(ctx, acc, 'zalo:changeFriendAlias', { alias, friendId: ctx.params.userId });
                    synced = true;
                }
                await ctx.call('db:setContactAlias', { zaloId: acc.id, contactId: ctx.params.userId, alias });
                return { alias, synced };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/friend-aliases', scope: 'contacts:read', tags: ctags, operationId: 'listFriendAliases',
            summary: 'Tên gợi nhớ đã đặt trên Zalo',
            params: accountParams,
            query: s.object({ page: s.int().min(1).max(1000).default(1), count: s.int().min(1).max(500).default(200) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'tên gợi nhớ');
                const r = await zalo(ctx, acc, 'zalo:getAliasList', { count: ctx.query.count, page: ctx.query.page });
                const items: any[] = r?.items || [];
                return items.map(i => ({ user_id: String(i.userId ?? i.uid ?? ''), alias: i.alias ?? '' })).filter(i => i.user_id);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/friend-recommendations', scope: 'contacts:read', tags: ctags, operationId: 'listFriendRecommendations',
            summary: 'Gợi ý kết bạn và lời mời mới từ Zalo',
            description: '`kind`: `request` = người ta gửi lời mời cho bạn, `suggestion` = Zalo gợi ý.',
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'gợi ý kết bạn');
                const r = await zalo(ctx, acc, 'zalo:getFriendRecommendations', {}, 60_000);
                return (r?.recommItems || []).map((item: any) => {
                    const d = item?.dataInfo || {};
                    return {
                        user_id: String(d.userId || ''),
                        display_name: d.displayName || d.zaloName || '',
                        avatar_url: d.avatar || '',
                        phone: d.phoneNumber || '',
                        kind: d.recommType === 2 ? 'request' : 'suggestion',
                        message: d.recommInfo?.message || d.recommInfo?.customText || '',
                        time: Number(d.recommTime || 0),
                    };
                }).filter((x: any) => x.user_id);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/users/:userId/friend-status', scope: 'contacts:read', tags: ctags, operationId: 'getFriendStatus',
            summary: 'Trạng thái bạn bè với một người (Zalo)',
            params: userParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                zaloOnly(acc, 'trạng thái kết bạn');
                const r = await zalo(ctx, acc, 'zalo:getFriendRequestStatus', { userId: ctx.params.userId });
                return {
                    is_friend: !!Number(r?.is_friend ?? 0),
                    request_sent: !!Number(r?.is_requested ?? 0),
                    request_received: !!Number(r?.is_requesting ?? 0),
                };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/contacts/search', scope: 'contacts:read', tags: ctags, operationId: 'searchContacts',
            summary: 'Tìm liên hệ & nhóm đã lưu (không dấu: "duong" ra "Dương"), xếp theo độ khớp',
            params: accountParams,
            query: s.object({
                q: s.string().max(200).default(''),
                type: s.enum(['all', 'user', 'group'] as const).default('all'),
                limit: s.int().min(1).max(200).default(50),
                offset: s.int().min(0).default(0),
            }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { q, type, limit, offset } = ctx.query;
                const r = await ctx.call('db:searchContactsForPicker', { zaloId: acc.id, search: q, type, limit, offset });
                const items = (r?.items || []).map((c: any) => ({
                    id: c.id, name: c.name, original_name: c.originalName ?? null, avatar_url: c.avatar || '', phone: c.phone || '',
                    type: c.type, is_friend: !!c.isFriend, last_activity: c.lastActivity || 0,
                }));
                return { items, total: Number(r?.total) || 0, counts: r?.counts || { all: 0, user: 0, group: 0 } };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/usernames/:username', scope: 'contacts:read', tags: ctags, operationId: 'resolveTelegramUsername',
            summary: 'Tra @username Telegram ra người dùng / nhóm',
            params: s.object({ accountId: s.id(), username: s.string().min(3).max(64).describe('Có hoặc không có @') }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.TELEGRAM_USER) return unsupported(acc, 'tra username');
                requireOnline(acc);
                const r = await ctx.call('telegramUser:resolveUsername', { accountId: acc.id, username: String(ctx.params.username).replace(/^@/, '') });
                return scrub(r?.peer ?? null);
            },
        }),
    ];
}
