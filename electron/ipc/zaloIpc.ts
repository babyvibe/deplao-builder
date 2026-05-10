import { ipcMain } from 'electron';
import ZaloService from '../../src/services/ZaloService';
import WorkflowEngineService from '../../src/services/WorkflowEngineService';
import ConnectionManager from '../../src/utils/ConnectionManager';
import HttpConnectionManager from '../../src/services/HttpConnectionManager';
import DatabaseService from '../../src/services/DatabaseService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import EventBroadcaster from '../../src/services/EventBroadcaster';

/**
 * Registry of IPC handler functions.
 * Used by HttpRelayService to invoke handlers directly on the boss side
 * without going through Electron's internal ipcMain._invokeHandlers.
 */
export const ipcHandlerRegistry = new Map<string, (event: any, params: any) => Promise<any>>();

async function getService(auth: any, isReconnection = false): Promise<ZaloService> {
    return await ZaloService.getInstance(auth, isReconnection);
}

/** Lấy zaloId từ auth.cookies qua ConnectionManager */
function resolveZaloId(auth: any): string {
    try {
        const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
        const cookies = authObj?.cookies || '';
        if (!cookies) return '';
        const cookiesB64 = Buffer.from(cookies).toString('base64');

        // Primary: exact match by cookies base64
        for (const [id, conn] of ConnectionManager.getAllConnections()) {
            if (conn.authKey === cookiesB64) return id;
        }

        // Fallback: look up zaloId from DB by cookies, then check if connection exists
        // (handles case where cookies in DB are stale but the account IS connected)
        try {
            const rows = (DatabaseService.getInstance() as any).query(
                `SELECT zalo_id FROM accounts WHERE cookies = ? LIMIT 1`, [cookies]
            );
            const dbZaloId = rows?.[0]?.zalo_id;
            if (dbZaloId && ConnectionManager.isConnected(dbZaloId)) {
                return dbZaloId;
            }
        } catch {}

        // Last resort: if only 1 connection exists, use it
        // (common case: boss has single Zalo account)
        const allConns = ConnectionManager.getAllConnections();
        if (allConns.size === 1) {
            const [onlyId] = allConns.keys();
            Logger.log(`[zaloIpc] resolveZaloId: cookies mismatch but using only connection: ${onlyId}`);
            return onlyId;
        }
    } catch {}
    return '';
}

function wrap(channel: string, fn: (service: ZaloService, params: any) => Promise<any>) {
    const handler = async (_event: any, params: any) => {
        try {
            // ─── Workspace-aware proxy routing ─────────────────────────
            // Skip if this call comes from HttpRelayService (boss-side proxy)
            const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
            if (activeWs?.type === 'remote' && !params?._fromRelay) {
                try {
                    return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, channel, params);
                } catch (proxyErr: any) {
                    Logger.error(`[zaloIpc] Proxy error (${channel}): ${proxyErr.message}`);
                    return { success: false, error: `Proxy: ${proxyErr.message}` };
                }
            }
            // ───────────────────────────────────────────────────────────

            // Strip relay flag before passing to service
            const { auth, isReconnection = false, _fromRelay, ...rest } = params;
            if (!auth) return { error: 'Missing auth' };

            const zaloId = resolveZaloId(auth);

            // ─── Chặn tài khoản không có connection (đã ngắt kết nối) ──
            if (!isReconnection && !zaloId) {
                const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
                const hasCookies = !!(authObj?.cookies);
                const connCount = ConnectionManager.getAllConnections().size;
                Logger.warn(`[zaloIpc] Blocked ${channel}: no active connection (hasCookies=${hasCookies}, activeConnections=${connCount})`);
                return { success: false, error: 'Tài khoản chưa kết nối.' };
            }
            // ────────────────────────────────────────────────────────────

            const service = await getService(typeof auth === 'string' ? auth : JSON.stringify(auth), isReconnection);
            const result = await fn(service, rest);
            return { success: true, response: result };
        } catch (error: any) {
            const errorMsg = error?.message || error?.toString() || 'Unknown error';
            Logger.error(`[zaloIpc] ${channel} error:`, error);
            return { success: false, error: errorMsg };
        }
    };

    // Register in both ipcMain and our handler registry
    ipcMain.handle(channel, handler);
    ipcHandlerRegistry.set(channel, handler);
}

export function registerZaloIpc() {
    // ─── Tin nhắn ────────────────────────────────────────────────────────
    wrap('zalo:sendMessage', (s, p) =>
        s.sendMessage(p.message, p.threadId, p.type, p.typeMessage, p.quote, p.mentions, p.styles)
    );

    wrap('zalo:sendSticker', (s, p) =>
        s.sendSticker(p.stickerId, p.threadId, p.type)
    );

    wrap('zalo:sendImage', (s, p) =>
        s.sendImage(p.filePath, p.threadId, p.type, p.message, p.quote)
    );

    wrap('zalo:sendImages', (s, p) =>
        s.sendImages(p.filePaths, p.threadId, p.type, p.quote)
    );

    wrap('zalo:sendFile', (s, p) =>
        s.sendFile(p.filePath, p.threadId, p.type, p.quote)
    );

    wrap('zalo:sendVoice', (s, p) =>
        s.sendVoice(p.options, p.threadId, p.type, p.quote)
    );

    wrap('zalo:uploadVoiceFile', (s, p) =>
        s.uploadVoiceFile(p.voicePath, p.threadId, p.type)
    );

    wrap('zalo:sendVideo', (s, p) =>
        s.sendVideo(p.options, p.threadId, p.type, p.quote)
    );

    wrap('zalo:uploadVideoThumb', (s, p) =>
        s.uploadVideoThumb(p.thumbPath, p.threadId, p.type)
    );

    wrap('zalo:uploadVideoFile', (s, p) =>
        s.uploadVideoFile(p.videoPath, p.threadId, p.type)
    );

    wrap('zalo:sendLink', (s, p) =>
        s.sendLink(p.url, p.threadId, p.type, p.quote, p.message)
    );

    wrap('zalo:sendCard', (s, p) =>
        s.sendCard([{ options: p.options, threadId: p.threadId, type: p.type, quote: p.quote }])
    );

    wrap('zalo:undoMessage', (s, p) =>
        s.undoMessage(p.message)
    );

    wrap('zalo:deleteMessage', (s, p) =>
        s.deleteMessage(p.message, p.onlyMe)
    );

    wrap('zalo:deleteChat', (s, p) =>
        s.deleteChat(p.lastMessage, p.threadId, p.type)
    );

    wrap('zalo:addReaction', (s, p) =>
        s.addReaction(p.reactionType, p.message)
    );
    // NOTE: No manual self-broadcast needed here.
    // Zalo DOES fire the "reaction" listener event for self-reactions (isSelf: true).
    // ZaloLoginHelper handles all reactions (including self) via EventBroadcaster.broadcastReaction.
    // Adding a manual broadcast here would cause double events at boss and duplicate relay to employees.

    wrap('zalo:forwardMessage', (s, p) =>
        s.forwardMessage(p.message, p.threadIds, p.type)
    );

    // ─── Lịch sử tin nhắn ────────────────────────────────────────────────
    wrap('zalo:getMessageHistory', (s, p) =>
        s.getMessageHistory(p.threadId, p.type, p.lastMsgId, p.count)
    );

    wrap('zalo:getGroupChatHistory', async (s, p) => {
        let result: any;
        try {
            result = await s.getGroupChatHistory(p.groupId, p.count ?? 500);
        } catch (apiErr: any) {
            Logger.warn(`[zaloIpc] getGroupChatHistory API error for group ${p.groupId}: ${apiErr.message}`);
            return { groupMsgsCount: 0, error: apiErr.message };
        }
        Logger.info(`[zaloIpc] getGroupChatHistory raw result keys: ${Object.keys(result || {}).join(', ')}`);
        // zca-js trả về { groupMsgs: GroupMessage[] }
        // Mỗi GroupMessage đã được wrap thành object có { data, threadId, type, isSelf, ... }
        const zaloId = s.getZaloId();
        const rawMsgs = result?.groupMsgs || result?.data;
        const msgs = Array.isArray(rawMsgs) ? rawMsgs : [];
        Logger.info(`[zaloIpc] getGroupChatHistory: zaloId=${zaloId}, msgs.length=${msgs.length}, groupId=${p.groupId}`);
        if (zaloId && msgs.length > 0) {
            let count = 0;
            for (const message of msgs) {
                try {
                    message.zaloId = zaloId;
                    await EventBroadcaster.broadcastMessage(zaloId, message, { silent: true });
                    count++;
                } catch (err: any) {
                    Logger.warn(`[zaloIpc] getGroupChatHistory broadcast error: ${err.message}`);
                }
            }
            Logger.info(`[zaloIpc] getGroupChatHistory: processed ${count}/${msgs.length} messages for group ${p.groupId}`);
        }
        return { groupMsgsCount: msgs.length };
    });

    // ─── Bạn bè ───────────────────────────────────────────────────────────
    wrap('zalo:getFriends', (s) => s.getAllFriends());

    wrap('zalo:findUser', (s, p) =>
        s.findUser(p.phone || p.username)
    );

    wrap('zalo:getUserInfo', (s, p) =>
        s.getUserInfo(p.userId)
    );

    // Lấy context của phiên đăng nhập (uid, phone, loginInfo, ...)
    {
        const handler = async (_event: any, params: any) => {
            try {
                const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
                if (activeWs?.type === 'remote' && !params?._fromRelay) {
                    return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, 'zalo:getContext', params);
                }
                const { auth, _fromRelay } = params;
            if (!auth) return { success: false, error: 'Missing auth' };
            const zaloId = resolveZaloId(auth);
            const service = await getService(typeof auth === 'string' ? auth : JSON.stringify(auth));
            const context = service.getContext();

            // Serialize cookie thành plain object để tránh lỗi "object could not be cloned"
            let cookieSerialized: any = null;
            try {
                cookieSerialized = context.cookie?.serializeSync
                    ? context.cookie.serializeSync()
                    : context.cookie?.toJSON?.()
                    ?? null;
            } catch (_) {}

            // Chỉ trả về các field serializable (bỏ CookieJar object)
            const safeContext = {
                uid: context.uid,
                imei: context.imei,
                userAgent: context.userAgent,
                language: context.language,
                secretKey: context.secretKey,
                cookie: cookieSerialized,
                loginInfo: context.loginInfo,
                extraVer: context.extraVer,
                settings: context.settings,
                zpwServiceMap: context.zpwServiceMap,
                API_TYPE: context.API_TYPE,
                API_VERSION: context.API_VERSION,
            };

            // Log đầy đủ để debug
            Logger.info('[zaloIpc] getContext safeContext:\n' + JSON.stringify(safeContext, null, 2));

            return { success: true, response: safeContext };
        } catch (error: any) {
            Logger.error('[zaloIpc] zalo:getContext error:', error);
            return { success: false, error: error?.message || String(error) };
        }
        };
        ipcMain.handle('zalo:getContext', handler);
        ipcHandlerRegistry.set('zalo:getContext', handler);
    }

    wrap('zalo:sendFriendRequest', (s, p) =>
        s.sendFriendRequest(p.msg || '', p.userId)
    );

    wrap('zalo:acceptFriendRequest', (s, p) =>
        s.acceptFriendRequest(p.userId)
    );

    wrap('zalo:rejectFriendRequest', (s, p) =>
        s.rejectFriendRequest(p.userId)
    );

    wrap('zalo:undoFriendRequest', (s, p) =>
        (s as any).undoFriendRequest(p.userId)
    );

    wrap('zalo:removeFriend', (s, p) =>
        (s as any).removeFriend(p.userId)
    );

    wrap('zalo:getSentFriendRequests', (s) => s.getSentFriendRequest());

    wrap('zalo:getFriendRecommendations', (s) => s.getFriendRecommendations());

    wrap('zalo:getAliasList', (s, p) =>
        s.getAliasList(p.count || 500, p.page || 1)
    );

    wrap('zalo:getFriendRequestStatus', (s, p) =>
        s.getFriendRequestStatus(p.userId)
    );

    wrap('zalo:blockUser', (s, p) => s.blockUser(p.userId));

    wrap('zalo:unblockUser', (s, p) => s.unblockUser(p.userId));

    wrap('zalo:getRelatedFriendGroup', (s, p) => s.getRelatedFriendGroup(p.userId));

    // ─── Nhóm ────────────────────────────────────────────────────────────
    wrap('zalo:getGroups', (s) => s.getAllGroups());

    wrap('zalo:getGroupInfo', (s, p) => s.getGroupInfo(p.groupId));

    wrap('zalo:createGroup', (s, p) =>
        s.createGroup({ name: p.name, members: p.members || p.memberIds, avatarPath: p.avatarPath })
    );

    wrap('zalo:addUserToGroup', (s, p) =>
        s.addUserToGroup(p.userId, p.groupId)
    );

    wrap('zalo:removeUserFromGroup', (s, p) =>
        s.removeUserFromGroup(p.userId, p.groupId)
    );

    wrap('zalo:leaveGroup', (s, p) => s.leaveGroup(p.groupId));

    wrap('zalo:changeGroupName', (s, p) =>
        s.changeGroupName(p.name, p.groupId)
    );

    wrap('zalo:changeGroupAvatar', (s, p) =>
        s.changeGroupAvatar(p.avatarPath, p.groupId)
    );

    wrap('zalo:changeGroupOwner', (s, p) =>
        s.changeGroupOwner(p.userId, p.groupId)
    );

    wrap('zalo:disperseGroup', (s, p) =>
        s.disperseGroup(p.groupId)
    );

    wrap('zalo:addGroupDeputy', (s, p) =>
        s.addGroupDeputy(p.userId, p.groupId)
    );

    wrap('zalo:removeGroupDeputy', (s, p) =>
        s.removeGroupDeputy(p.userId, p.groupId)
    );

    wrap('zalo:getGroupMembersInfo', (s, p) =>
        s.getGroupMembersInfo(p.groupId, p.memberIds)
    );

    wrap('zalo:addGroupBlockedMember', (s, p) =>
        s.addGroupBlockedMember(p.userId, p.groupId)
    );

    wrap('zalo:removeGroupBlockedMember', (s, p) =>
        s.removeGroupBlockedMember(p.userId, p.groupId)
    );

    wrap('zalo:getGroupBlockedMember', (s, p) =>
        s.getGroupBlockedMember(p.groupId)
    );

    wrap('zalo:inviteUserToGroups', (s, p) =>
        s.inviteUserToGroups(p.userId, p.groupIds)
    );

    wrap('zalo:updateGroupSettings', (s, p) => {
        // Pre-seed the EventBroadcaster settings cache with the PREVIOUS (before-toggle) settings
        // so that when the update_setting group event comes back we can diff and show text.
        if (p.oldSettings && p.groupId) {
            try {
                const oldSettingsParsed = typeof p.oldSettings === 'string'
                    ? JSON.parse(p.oldSettings) : p.oldSettings;
                EventBroadcaster.seedGroupSettings(s.getZaloId() || '', p.groupId, oldSettingsParsed);
            } catch {}
        }
        return s.updateGroupSettings(p.settings, p.groupId);
    });

    wrap('zalo:getGroupLinkDetail', (s, p) =>
        s.getGroupLinkDetail(p.groupId)
    );

    wrap('zalo:getGroupLinkInfo', (s, p) =>
        s.getGroupLinkInfo(p.link, p.memberPage)
    );

    wrap('zalo:enableGroupLink', (s, p) =>
        s.enableGroupLink(p.groupId)
    );

    wrap('zalo:disableGroupLink', (s, p) =>
        s.disableGroupLink(p.groupId)
    );

    wrap('zalo:getPendingGroupMembers', (s, p) =>
        s.getPendingGroupMembers(p.groupId)
    );

    wrap('zalo:reviewPendingMemberRequest', (s, p) =>
        s.reviewPendingMemberRequest(p.payload, p.groupId)
    );

    // ─── Hội thoại ────────────────────────────────────────────────────────
    wrap('zalo:getPinConversations', (s) => s.getPinConversations());

    wrap('zalo:setPinConversation', (s, p) =>
        s.setPinConversations(p.conversations, p.isPin)
    );

    wrap('zalo:setMute', (s, p) =>
        s.setMute(p.threadId, p.threadType ?? 0, p.duration, p.action)
    );

    // ─── Labels ───────────────────────────────────────────────────────────
    // getLabels dùng HTTP thuần, không cần WS connection active
    // → không dùng wrap() để tránh bị block bởi !zaloId guard
    {
        const handler = async (_event: any, params: any) => {
            try {
                const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
                if (activeWs?.type === 'remote' && !params?._fromRelay) {
                    return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, 'zalo:getLabels', params);
                }
                const { auth, _fromRelay } = params;
                if (!auth) return { success: false, error: 'Missing auth' };
                const zaloId = resolveZaloId(auth);
                const service = await getService(typeof auth === 'string' ? auth : JSON.stringify(auth), false);
                const result = await service.getLabels();
                Logger.info(`[zaloIpc] zalo:getLabels ✅ got ${result?.labelData?.length ?? 0} labels`);
                return { success: true, response: result };
            } catch (error: any) {
                Logger.error('[zaloIpc] zalo:getLabels error:', error);
                return { success: false, error: error?.message || String(error) };
            }
        };
        ipcMain.handle('zalo:getLabels', handler);
        ipcHandlerRegistry.set('zalo:getLabels', handler);
    }

    // ─── updateLabels: full handler to emit workflow events ─────────────
    {
        const handler = async (_event: any, params: any) => {
            try {
                const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
                if (activeWs?.type === 'remote' && !params?._fromRelay) {
                    return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, 'zalo:updateLabels', params);
                }
                const { auth, isReconnection = false, _fromRelay, labelData, version, labelDiffs, ...rest } = params;
            if (!auth) return { error: 'Missing auth' };

            const zaloId = resolveZaloId(auth);
            if (!isReconnection && !zaloId) {
                Logger.warn(`[zaloIpc] Blocked zalo:updateLabels: no active connection`);
                return { success: false, error: 'Tài khoản chưa kết nối.' };
            }

            const service = await getService(typeof auth === 'string' ? auth : JSON.stringify(auth), isReconnection);
            const result = await service.updateLabels(labelData, version);

            // Centralized workflow label event emission
            if (Array.isArray(labelDiffs) && labelDiffs.length > 0 && zaloId) {
                try {
                    const engine = WorkflowEngineService.getInstance();
                    for (const diff of labelDiffs) {
                        engine.triggerLabelEvent({
                            zaloId,
                            threadId: diff.threadId,
                            threadType: diff.threadType ?? 0,
                            labelId: diff.labelId,
                            labelText: diff.labelText || '',
                            labelColor: diff.labelColor || '',
                            labelEmoji: diff.labelEmoji || '',
                            labelSource: 'zalo',
                            action: diff.action,
                        });
                    }
                } catch (err: any) {
                    Logger.error(`[zaloIpc] updateLabels workflow event error: ${err.message}`);
                }
            }

            return { success: true, response: result };
        } catch (error: any) {
            const errorMsg = error?.message || error?.toString() || 'Unknown error';
            Logger.error(`[zaloIpc] zalo:updateLabels error:`, error);
            return { success: false, error: errorMsg };
        }
        };
        ipcMain.handle('zalo:updateLabels', handler);
        ipcHandlerRegistry.set('zalo:updateLabels', handler);
    }

    wrap('zalo:changeFriendAlias', (s, p) =>
        s.changeFriendAlias(p.alias, p.friendId)
    );

    wrap('zalo:getStickers', (s, p) => {
        const kw = (p.keyword || '').trim();
        if (!kw) throw new Error('Missing keyword');
        return s.getStickers(kw);
    });

    wrap('zalo:getStickersDetail', (s, p) =>
        s.getStickersDetail(p.stickerIds)
    );

    wrap('zalo:getStickerCategoryDetail', (s, p) =>
        s.getStickerCategoryDetail(p.cateId)
    );

    // ─── Keep Alive ───────────────────────────────────────────────────────
    wrap('zalo:keepAlive', (s) => s.keepAlive());

    // ─── Unread Mark ──────────────────────────────────────────────────────────
    wrap('zalo:addUnreadMark', (s, p) =>
        s.addUnreadMark(p.threadId, p.type)
    );

    wrap('zalo:removeUnreadMark', (s, p) =>
        s.removeUnreadMark(p.threadId, p.type)
    );

    // ─── Poll ─────────────────────────────────────────────────────────────────
    wrap('zalo:createPoll', (s, p) =>
        s.createPoll(p.options, p.groupId)
    );

    wrap('zalo:getPollDetail', (s, p) =>
        s.getPollDetail(p.pollId)
    );

    wrap('zalo:lockPoll', (s, p) =>
        s.lockPoll(Number(p.pollId))
    );

    wrap('zalo:doVotePoll', (s, p) =>
        s.doVotePoll(Number(p.pollId), p.optionIds as number[])
    );

    wrap('zalo:addPollOption', (s, p) =>
        s.addPollOption(Number(p.pollId), p.option as string)
    );

    // ─── Tin nhắn nhanh ───────────────────────────────────────────────────────
    wrap('zalo:getQuickMessageList', (s) => s.getQuickMessageList());

    wrap('zalo:addQuickMessage', (s, p) =>
        s.addQuickMessage({ keyword: p.keyword, title: p.title, mediaPath: p.mediaPath })
    );

    wrap('zalo:updateQuickMessage', (s, p) =>
        s.updateQuickMessage({ keyword: p.keyword, title: p.title, mediaPath: p.mediaPath }, Number(p.itemId))
    );

    wrap('zalo:removeQuickMessage', (s, p) =>
        s.removeQuickMessage(p.itemIds)
    );

    // ─── Ghi chú nhóm ─────────────────────────────────────────────────────────
    wrap('zalo:createNote', (s, p) =>
        s.createNote({ title: p.title, pinAct: p.pinAct }, p.groupId)
    );

    wrap('zalo:editNote', (s, p) =>
        s.editNote({ title: p.title, topicId: p.topicId, pinAct: p.pinAct }, p.groupId)
    );

    // ─── Nhắc hẹn ─────────────────────────────────────────────────────────────
    wrap('zalo:createReminder', (s, p) => {
        Logger.info('[zaloIpc] createReminder params:', JSON.stringify(p, null, 2));
        return s.createReminder(p.options, p.threadId, p.type);
    });

    wrap('zalo:editReminder', (s, p) =>
        s.editReminder(p.options, p.threadId, p.type)
    );

    wrap('zalo:removeReminder', (s, p) =>
        s.removeReminder(p.reminderId, p.threadId, p.type)
    );

    wrap('zalo:getListReminder', (s, p) =>
        s.getListReminder(p.options, p.threadId, p.type)
    );

    wrap('zalo:getReminder', (s, p) =>
        s.getReminder(p.reminderId)
    );

    // ─── Sự kiện đã đọc ────────────────────────────────────────────────────
    wrap('zalo:sendSeenEvent', (s, p) =>
        s.sendSeenEvent(p.messages, p.type)
    );

    // ─── Gửi thẻ ngân hàng ─────────────────────────────────────────────────
    wrap('zalo:sendBankCard', (s, p) =>
        s.sendBankCard(p.payload, p.threadId, p.type)
    );
}
