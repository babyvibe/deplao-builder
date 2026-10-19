/**
 * Nhóm chat, bạn bè, tra cứu người dùng.
 * Kênh IPC: db:getContactsFiltered (contactType group), zalo:getGroupInfo, db:getGroupMembers,
 * zalo:addUserToGroup, zalo:removeUserFromGroup, zalo:changeGroupName, zalo:getGroupLinkDetail,
 * zalo:enableGroupLink, zalo:disableGroupLink, zalo:createGroup, zalo:leaveGroup,
 * telegramUser:getFullChat/getGroupMembers/addChatUser/deleteChatUser/editChatTitle/exportChatInvite/leaveChat,
 * fb:changeThreadName, db:getFriends, zalo:getFriends, db:getFriendRequests, zalo:getSentFriendRequests,
 * zalo:sendFriendRequest, zalo:acceptFriendRequest, zalo:rejectFriendRequest, zalo:undoFriendRequest,
 * zalo:removeFriend, db:removeFriend, zalo:getUserInfo, zalo:findUser, db:searchContactByPhone.
 */
import { s } from '../schema';
import { AccountInfo, ApiContext, route, RouteDef } from '../types';
import { CHANNELS, requireOnline, unsupported } from '../channels/ChannelActions';
import { accountParams, mapConversation, offsetPage, pageShape, scrub } from './common';

const groupParams = s.object({ accountId: s.id(), groupId: s.id().describe('ID nhóm (thread_id)') });
const userParams = s.object({ accountId: s.id(), userId: s.id().describe('ID người dùng trên kênh') });

async function zaloCall(ctx: ApiContext, acc: AccountInfo, channel: string, payload: Record<string, any>, timeoutMs?: number) {
    requireOnline(acc);
    const res = await ctx.call(channel, { auth: await ctx.zaloAuth(acc.id), ...payload }, timeoutMs ? { timeoutMs } : undefined);
    return res?.response ?? res;
}

export function groupRoutes(): RouteDef[] {
    const tags = ['Nhóm'];
    const ctags = ['Danh bạ'];
    return [
        route({
            method: 'GET', path: '/accounts/:accountId/groups', scope: 'chat:read', tags, operationId: 'listGroups',
            summary: 'Nhóm của tài khoản (từ DB, mới hoạt động trước)',
            params: accountParams,
            query: s.object({ ...pageShape, search: s.string().max(200).optional() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { limit, offset, search } = ctx.query;
                const res = await ctx.call('db:getContactsFiltered', { zaloId: acc.id, contactType: 'group', search: search || undefined, limit, offset });
                return offsetPage((res?.contacts || []).map(mapConversation), limit, offset);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/groups/:groupId', scope: 'chat:read', tags, operationId: 'getGroup',
            summary: 'Thông tin nhóm từ kênh (thành viên, admin, cài đặt)',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const groupId = ctx.params.groupId;
                if (acc.channel === CHANNELS.ZALO) {
                    const r = await zaloCall(ctx, acc, 'zalo:getGroupInfo', { groupId });
                    return scrub(r?.gridInfoMap?.[groupId] ?? r);
                }
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    requireOnline(acc);
                    return scrub(await ctx.call('telegramUser:getFullChat', { accountId: acc.id, chatId: groupId }));
                }
                const c = await ctx.call('db:getContactById', { zaloId: acc.id, contactId: groupId });
                return mapConversation(c?.contact);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/groups/:groupId/members', scope: 'chat:read', tags, operationId: 'listGroupMembers',
            summary: 'Thành viên nhóm (Zalo: danh sách đã lưu; Telegram: lấy từ kênh)',
            params: groupParams,
            query: s.object({ limit: s.int().min(1).max(1000).default(200) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    requireOnline(acc);
                    const r = await ctx.call('telegramUser:getGroupMembers', { accountId: acc.id, chatId: ctx.params.groupId, limit: ctx.query.limit });
                    return scrub(r?.members ?? r);
                }
                const r = await ctx.call('db:getGroupMembers', { zaloId: acc.id, groupId: ctx.params.groupId });
                return (r?.members || []).slice(0, ctx.query.limit);
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/members', scope: 'chat:manage', tags, operationId: 'addGroupMembers',
            summary: 'Thêm thành viên vào nhóm',
            params: groupParams,
            body: s.object({ user_ids: s.array(s.id()).min(1).max(50) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.ZALO) {
                    return { result: scrub(await zaloCall(ctx, acc, 'zalo:addUserToGroup', { userId: ctx.body.user_ids, groupId: ctx.params.groupId })) };
                }
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    requireOnline(acc);
                    const results = [];
                    for (const userId of ctx.body.user_ids) {
                        results.push(await ctx.call('telegramUser:addChatUser', { accountId: acc.id, chatId: ctx.params.groupId, userId }));
                    }
                    return { result: scrub(results) };
                }
                return unsupported(acc, 'thêm thành viên');
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/groups/:groupId/members/:userId', scope: 'chat:manage', tags, operationId: 'removeGroupMember',
            summary: 'Mời một thành viên ra khỏi nhóm',
            params: s.object({ accountId: s.id(), groupId: s.id(), userId: s.id() }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.ZALO) {
                    await zaloCall(ctx, acc, 'zalo:removeUserFromGroup', { userId: ctx.params.userId, groupId: ctx.params.groupId });
                    return { removed: true };
                }
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    requireOnline(acc);
                    await ctx.call('telegramUser:deleteChatUser', { accountId: acc.id, chatId: ctx.params.groupId, userId: ctx.params.userId });
                    return { removed: true };
                }
                return unsupported(acc, 'xoá thành viên');
            },
        }),
        route({
            method: 'PATCH', path: '/accounts/:accountId/groups/:groupId', scope: 'chat:manage', tags, operationId: 'renameGroup',
            summary: 'Đổi tên nhóm',
            params: groupParams,
            body: s.object({ name: s.string().min(1).max(200) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const { groupId } = ctx.params;
                if (acc.channel === CHANNELS.ZALO) await zaloCall(ctx, acc, 'zalo:changeGroupName', { name: ctx.body.name, groupId });
                else if (acc.channel === CHANNELS.FACEBOOK) { requireOnline(acc); await ctx.call('fb:changeThreadName', { accountId: acc.id, threadId: groupId, name: ctx.body.name }); }
                else if (acc.channel === CHANNELS.TELEGRAM_USER) { requireOnline(acc); await ctx.call('telegramUser:editChatTitle', { accountId: acc.id, chatId: groupId, title: ctx.body.name }); }
                else unsupported(acc, 'đổi tên nhóm');
                return { renamed: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/groups/:groupId/invite-link', scope: 'chat:manage', tags, operationId: 'getGroupInviteLink',
            summary: 'Link mời vào nhóm',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.ZALO) return scrub(await zaloCall(ctx, acc, 'zalo:getGroupLinkDetail', { groupId: ctx.params.groupId }));
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    requireOnline(acc);
                    const r = await ctx.call('telegramUser:exportChatInvite', { accountId: acc.id, chatId: ctx.params.groupId });
                    return { link: r?.link ?? null };
                }
                return unsupported(acc, 'link mời nhóm');
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/invite-link', scope: 'chat:manage', tags, operationId: 'enableGroupInviteLink',
            summary: 'Bật link mời (Zalo)',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'bật link mời');
                return scrub(await zaloCall(ctx, acc, 'zalo:enableGroupLink', { groupId: ctx.params.groupId }));
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId/groups/:groupId/invite-link', scope: 'chat:manage', tags, operationId: 'disableGroupInviteLink',
            summary: 'Tắt link mời (Zalo)',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'tắt link mời');
                await zaloCall(ctx, acc, 'zalo:disableGroupLink', { groupId: ctx.params.groupId });
                return { disabled: true };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups', scope: 'chat:manage', tags, operationId: 'createGroup',
            summary: 'Tạo nhóm Zalo',
            params: accountParams,
            body: s.object({ name: s.string().min(1).max(200), member_ids: s.array(s.id()).min(1).max(100) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'tạo nhóm');
                return scrub(await zaloCall(ctx, acc, 'zalo:createGroup', { name: ctx.body.name, members: ctx.body.member_ids }));
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/groups/:groupId/leave', scope: 'chat:manage', tags, operationId: 'leaveGroup',
            summary: 'Rời nhóm',
            params: groupParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.ZALO) await zaloCall(ctx, acc, 'zalo:leaveGroup', { groupId: ctx.params.groupId });
                else if (acc.channel === CHANNELS.TELEGRAM_USER) { requireOnline(acc); await ctx.call('telegramUser:leaveChat', { accountId: acc.id, chatId: ctx.params.groupId }); }
                else unsupported(acc, 'rời nhóm');
                return { left: true };
            },
        }),

        // ── Bạn bè & người dùng ───────────────────────────────────────────
        route({
            method: 'GET', path: '/accounts/:accountId/friends', scope: 'contacts:read', tags: ctags, operationId: 'listFriends',
            summary: 'Danh sách bạn bè (Zalo). refresh=true tải lại từ Zalo',
            params: accountParams,
            query: s.object({ ...pageShape, search: s.string().max(200).optional(), refresh: s.boolean().default(false) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'danh sách bạn bè');
                const { limit, offset, search, refresh } = ctx.query;
                if (refresh) {
                    const fresh = await zaloCall(ctx, acc, 'zalo:getFriends', {}, 120_000);
                    const list = Array.isArray(fresh) ? fresh : [];
                    if (list.length) await ctx.call('db:saveFriends', { zaloId: acc.id, friends: list }).catch(() => null);
                }
                const r = await ctx.call('db:getFriends', { zaloId: acc.id });
                let rows: any[] = r?.friends || [];
                if (search) {
                    const q = String(search).toLowerCase();
                    rows = rows.filter(f => String(f.display_name || '').toLowerCase().includes(q) || String(f.phone || '').includes(q));
                }
                return offsetPage(rows.slice(offset, offset + limit), limit, offset, rows.length);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/friend-requests', scope: 'contacts:read', tags: ctags, operationId: 'listFriendRequests',
            summary: 'Lời mời kết bạn đã nhận / đã gửi',
            params: accountParams,
            query: s.object({ direction: s.enum(['received', 'sent'] as const).default('received') }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const r = await ctx.call('db:getFriendRequests', { zaloId: acc.id, direction: ctx.query.direction });
                return { items: r?.requests || [], last_fetched: r?.lastFetched ?? null };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/friend-requests', scope: 'contacts:write', tags: ctags, operationId: 'sendFriendRequest',
            summary: 'Gửi lời mời kết bạn (Zalo)',
            params: accountParams,
            body: s.object({ user_id: s.id(), message: s.string().max(150).default('') }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'kết bạn');
                return scrub(await zaloCall(ctx, acc, 'zalo:sendFriendRequest', { userId: ctx.body.user_id, msg: ctx.body.message }));
            },
        }),
        ...(['accept', 'reject', 'cancel'] as const).map(action => route({
            method: 'POST', path: `/accounts/:accountId/friend-requests/:userId/${action}`, scope: 'contacts:write', tags: ctags,
            operationId: `${action}FriendRequest`,
            summary: action === 'accept' ? 'Chấp nhận lời mời kết bạn' : action === 'reject' ? 'Từ chối lời mời kết bạn' : 'Huỷ lời mời đã gửi',
            params: userParams,
            handler: async (ctx: ApiContext) => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'lời mời kết bạn');
                const channel = action === 'accept' ? 'zalo:acceptFriendRequest' : action === 'reject' ? 'zalo:rejectFriendRequest' : 'zalo:undoFriendRequest';
                await zaloCall(ctx, acc, channel, { userId: ctx.params.userId });
                await ctx.call('db:removeFriendRequest', {
                    zaloId: acc.id, userId: ctx.params.userId, direction: action === 'cancel' ? 'sent' : 'received',
                }).catch(() => null);
                return { done: true };
            },
        })),
        route({
            method: 'DELETE', path: '/accounts/:accountId/friends/:userId', scope: 'contacts:write', tags: ctags, operationId: 'removeFriend',
            summary: 'Huỷ kết bạn (Zalo)',
            params: userParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) return unsupported(acc, 'huỷ kết bạn');
                await zaloCall(ctx, acc, 'zalo:removeFriend', { friendId: ctx.params.userId, userId: ctx.params.userId });
                await ctx.call('db:removeFriend', { zaloId: acc.id, userId: ctx.params.userId }).catch(() => null);
                return { removed: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/users/lookup', scope: 'contacts:read', tags: ctags, operationId: 'lookupUserByPhone',
            summary: 'Tìm người dùng theo số điện thoại (DB trước, rồi Zalo)',
            params: accountParams,
            query: s.object({ phone: s.string().min(6).max(20) }),
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                const local = await ctx.call('db:searchContactByPhone', { zaloId: acc.id, phone: ctx.query.phone });
                if (local?.contact) return { source: 'local', user: mapConversation(local.contact) };
                if (acc.channel !== CHANNELS.ZALO) return { source: 'none', user: null };
                const found = await zaloCall(ctx, acc, 'zalo:findUser', { phone: ctx.query.phone });
                return { source: 'zalo', user: scrub(found) };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/users/:userId', scope: 'contacts:read', tags: ctags, operationId: 'getUserProfile',
            summary: 'Hồ sơ người dùng từ Zalo',
            params: userParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel !== CHANNELS.ZALO) {
                    const c = await ctx.call('db:getContactById', { zaloId: acc.id, contactId: ctx.params.userId });
                    return mapConversation(c?.contact);
                }
                const r = await zaloCall(ctx, acc, 'zalo:getUserInfo', { userId: ctx.params.userId });
                return scrub(r?.changed_profiles?.[ctx.params.userId] ?? r?.unchanged_profiles?.[ctx.params.userId] ?? r);
            },
        }),
    ];
}
