import { ipcMain } from 'electron';
import ZaloService from '../../../src/services/zalo/ZaloService';
import WorkflowEngineService from '../../../src/services/workflow/WorkflowEngineService';
import ConnectionManager from '../../../src/utils/connection/ConnectionManager';
import HttpConnectionManager from '../../../src/services/http/HttpConnectionManager';
import DatabaseService from '../../../src/services/database/DatabaseService';
import WorkspaceManager from '../../../src/utils/app/WorkspaceManager';
import Logger from '../../../src/utils/Logger';
import EventBroadcaster from '../../../src/services/event/EventBroadcaster';
import FileStorageService from '../../../src/services/file/FileStorageService';
import { resolveZaloReminderTitle } from '../../../src/services/zalo/zaloReminderTitle';
// Upload the employee machine's files to Boss before proxying: shared with Facebook / Telegram (same list of fields Boss checks)
import { prepareLocalFilesForProxy } from '../network/proxyHelper';
import type { ContactsInfoRefreshResult } from '../../../src/models/chat/contact';
import { tr } from '../../../src/shared/i18n';

/**
 * Registry of IPC handler functions.
 * Used by HttpRelayService to invoke handlers directly on the boss side
 * without going through Electron's internal ipcMain._invokeHandlers.
 */
export const ipcHandlerRegistry = new Map<string, (event: any, params: any) => Promise<any>>();

async function getService(auth: any, isReconnection = false): Promise<ZaloService> {
    return await ZaloService.getInstance(auth, isReconnection);
}

/** Get the zaloId from auth.cookies via ConnectionManager */
function resolveZaloId(auth: any, allowSingleConnectionFallback = true): string {
    try {
        const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
        const cookies = authObj?.cookies || '';

        if (cookies) {
            const cookiesB64 = Buffer.from(cookies).toString('base64');

            // Primary: exact match by cookies base64
            for (const [id, conn] of ConnectionManager.getAllConnections()) {
                if (conn.authKey === cookiesB64) return id;
            }

            // Fallback: look up zaloId from DB by cookies, then check if connection exists
            // (handles case where cookies in DB are stale but the account IS connected).
            // Compared on the decrypted value: accounts.cookies is stored encrypted (random), so WHERE cookies = ? never matches.
            try {
                const dbZaloId = DatabaseService.getInstance().getAccounts().find(a => a.cookies === cookies)?.zalo_id;
                if (dbZaloId && ConnectionManager.isConnected(dbZaloId)) {
                    return dbZaloId;
                }
            } catch {}
        }

        // Last resort: if only 1 connection exists, use it.
        // Sensitive profile lookups can opt out: a stale renderer auth must
        // never be silently redirected to whichever Zalo account is online.
        // (handles both: cookies mismatch AND cookies missing from auth object)
        // When the auth has no cookies (e.g. sending a quick message), it can still be sent
        // if there is only 1 connected Zalo account.
        const allConns = ConnectionManager.getAllConnections();
        if (allowSingleConnectionFallback && allConns.size === 1) {
            const [onlyId] = allConns.keys();
            Logger.log(`[zaloIpc] resolveZaloId: using only connection: ${onlyId}${cookies ? ' (cookies mismatch)' : ' (no cookies in auth)'}`);
            return onlyId;
        }
    } catch {}
    return '';
}

/**
 * When IPC has resolved an active Zalo connection, that connection is
 * the most trustworthy auth source. The cookie stored in the renderer/DB may have been
 * encrypted with an old session or be stale, even though the current listener is still alive.
 * Do not replace the auth when the cookie really matches, so the normal flow stays unchanged;
 * if cookies are missing or mismatched, reuse the connection's auth,
 * to avoid creating a new ZaloService with invalid data.
 */
function resolveAuthFromConnection(auth: any, zaloId: string): any {
    if (!zaloId) return auth;
    const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
    const conn = ConnectionManager.getConnection(zaloId);
    const connectionCookies = conn?.auth?.cookies;
    const requestCookies = authObj?.cookies;
    if (connectionCookies && requestCookies !== connectionCookies) {
        const reason = requestCookies ? 'cookies mismatch' : 'no cookies in request auth';
        Logger.log(`[zaloIpc] resolveAuthFromConnection: using connection auth for ${zaloId} (${reason})`);
        return conn.auth;
    }
    return auth;
}

function getExplicitAccountId(auth: any): string {
    try {
        const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
        return String(authObj?.zaloId || authObj?.zalo_id || authObj?.accountId || '');
    } catch {
        return '';
    }
}

// ─── Bulk refresh contact names/avatars by UID ──────────────────────────
const CONTACT_REFRESH_BATCH_SIZE = 50;
const CONTACT_REFRESH_BATCH_DELAY_MS = 300;
const CONTACT_REFRESH_MAX_IDS = 500;

/** Errors that make further calls pointless (session expired, wrong cookie, rate limited, network lost). */
function isContactRefreshStopError(err: any): boolean {
    const msg = String(err?.message || err || '').toLowerCase();
    return /rate.?limit|too many|quá nhiều|spam|session|expired|hết hạn|đăng nhập|login|unauthor|forbidden|cookie|not initialized|chưa kết nối|fetch failed|network|econn|timeout|\b(401|403|429)\b/.test(msg);
}

/**
 * zalo:refreshContactsInfo: calls getUserInfo in batches of 50 (sequential, waits 300 ms between batches), then writes
 * the name/avatar into contacts + friends by the UID of the signed-in account (UPDATE existing rows only).
 * On a session-expired / rate-limit error (or 2 failed batches in a row), it stops and returns a partial result.
 */
async function refreshContactsInfo(service: ZaloService, params: any): Promise<ContactsInfoRefreshResult> {
    const ownerZaloId = service.getZaloId() || '';
    const rawIds: unknown[] = Array.isArray(params?.userIds) ? params.userIds : [];
    const ids = Array.from(new Set(
        rawIds.map(id => String(id ?? '').trim()).filter(id => id && id !== 'undefined' && !id.includes('_'))
    )).slice(0, CONTACT_REFRESH_MAX_IDS);
    const result: ContactsInfoRefreshResult = { updated: 0, failed: [], checked: 0, profiles: [] };
    if (ids.length === 0) return result;
    if (!ownerZaloId) {
        result.failed = ids;
        result.error = tr('Không xác định được tài khoản Zalo.');
        return result;
    }

    const db = DatabaseService.getInstance();
    let consecutiveErrors = 0;
    for (let i = 0; i < ids.length; i += CONTACT_REFRESH_BATCH_SIZE) {
        const batch = ids.slice(i, i + CONTACT_REFRESH_BATCH_SIZE);
        if (i > 0) await new Promise(resolve => setTimeout(resolve, CONTACT_REFRESH_BATCH_DELAY_MS));
        let response: any;
        try {
            response = await service.getUserInfo(batch);
        } catch (err: any) {
            consecutiveErrors++;
            const msg = err?.message || String(err);
            result.failed.push(...batch);
            if (isContactRefreshStopError(err) || consecutiveErrors >= 2) {
                result.failed.push(...ids.slice(i + CONTACT_REFRESH_BATCH_SIZE));
                result.error = msg;
                Logger.warn(`[zaloIpc] zalo:refreshContactsInfo ${ownerZaloId}: dừng sau ${i + batch.length}/${ids.length} UID (${msg})`);
                break;
            }
            Logger.warn(`[zaloIpc] zalo:refreshContactsInfo ${ownerZaloId}: lô ${Math.floor(i / CONTACT_REFRESH_BATCH_SIZE) + 1} lỗi, thử lô tiếp: ${msg}`);
            continue;
        }
        consecutiveErrors = 0;
        const changed: Record<string, any> = response?.changed_profiles || {};
        const profiles: ContactsInfoRefreshResult['profiles'] = [];
        for (const id of batch) {
            // zca-js sends "<uid>_0"; the returned key may or may not include the suffix.
            const profile = changed[id] ?? changed[`${id}_0`] ?? null;
            const displayName = String(profile?.displayName || profile?.zaloName || '').trim();
            const avatarUrl = String(profile?.avatar || '').trim();
            if (profile && (displayName || avatarUrl)) profiles.push({ contactId: id, displayName, avatarUrl });
            else result.failed.push(id);
        }
        result.updated += db.applyContactInfoRefresh(ownerZaloId, profiles, batch);
        result.profiles.push(...profiles);
        result.checked += batch.length;
    }
    Logger.log(`[zaloIpc] zalo:refreshContactsInfo ${ownerZaloId}: ${result.updated} dòng DB cập nhật, ${result.profiles.length} profile, ${result.checked}/${ids.length} UID đã hỏi, ${result.failed.length} không có dữ liệu`);
    return result;
}

function wrap(channel: string, fn: (service: ZaloService, params: any) => Promise<any>) {
    const handler = async (_event: any, params: any) => {
        try {
            // ─── Workspace-aware proxy routing ─────────────────────────
            // Skip if this call comes from HttpRelayService (boss-side proxy)
            const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
            if (activeWs?.type === 'remote' && !params?._fromRelay) {
                try {
                    // Upload local files (images, videos, voice) from Employee to Boss
                    // before proxying - Employee's file paths don't exist on Boss machine.
                    const preparedParams = await prepareLocalFilesForProxy(params);
                    return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, channel, preparedParams);
                } catch (proxyErr: any) {
                    Logger.error(`[zaloIpc] Proxy error (${channel}): ${proxyErr.message}`);
                    return { success: false, error: `Proxy: ${proxyErr.message}` };
                }
            }
            // ───────────────────────────────────────────────────────────

            // Strip relay flag before passing to service
            let { auth, isReconnection = false, _fromRelay, ...rest } = params;
            if (!auth) return { error: 'Missing auth' };

            // getUserInfo is often triggered by passive UI hydration. Do not
            // let stale credentials from that UI work be redirected to the
            // only active Zalo connection; it is both misleading and can call
            // the wrong account while a non-Zalo channel is syncing.
            const requiresStrictAccount = channel === 'zalo:getUserInfo' || channel === 'zalo:refreshContactsInfo';
            const explicitAccountId = getExplicitAccountId(auth);
            let zaloId = resolveZaloId(auth, !requiresStrictAccount);

            if (requiresStrictAccount) {
                if (explicitAccountId) {
                    if (!ConnectionManager.isConnected(explicitAccountId)) {
                        Logger.warn(`[zaloIpc] Blocked ${channel}: explicit account ${explicitAccountId} is not an active Zalo connection`);
                        return { success: false, error: 'Tài khoản Zalo không còn kết nối.' };
                    }
                    if (zaloId && zaloId !== explicitAccountId) {
                        Logger.warn(`[zaloIpc] Blocked ${channel}: auth resolves to ${zaloId}, not explicit account ${explicitAccountId}`);
                        return { success: false, error: tr('Thông tin xác thực không khớp tài khoản Zalo.') };
                    }
                    zaloId = explicitAccountId;
                } else if (!zaloId) {
                    Logger.warn(`[zaloIpc] Blocked ${channel}: no exact active account match; refusing single-connection fallback`);
                    return { success: false, error: tr('Không xác định được tài khoản Zalo hợp lệ.') };
                }
            }

            // ─── Fallback: infer the zaloId from cookie-less auth + activeAccountId ──
            // When there are several connections and the cookies are empty, resolveZaloId cannot match.
            // Try the zaloId from the auth object (if the UI passes activeAccountId) or
            // from a cookies lookup in the DB.
            if (!zaloId) {
                const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
                const candidateId = authObj?.zaloId || authObj?.zalo_id || authObj?.accountId || '';
                if (candidateId && ConnectionManager.isConnected(String(candidateId))) {
                    zaloId = String(candidateId);
                    Logger.log(`[zaloIpc] resolveZaloId: matched from auth.zaloId: ${zaloId}`);
                }
            }

            // ─── Block accounts with no connection (disconnected) ──
            if (!isReconnection && !zaloId) {
                const authObj = typeof auth === 'string' ? JSON.parse(auth) : auth;
                const hasCookies = !!(authObj?.cookies);
                const connCount = ConnectionManager.getAllConnections().size;
                Logger.warn(`[zaloIpc] Blocked ${channel}: no active connection (hasCookies=${hasCookies}, activeConnections=${connCount})`);
                return { success: false, error: 'Tài khoản chưa kết nối.' };
            }
            // ────────────────────────────────────────────────────────────

            // ─── Auth fallback: if cookies are empty but there is a connection → use the connection's auth
            auth = resolveAuthFromConnection(auth, zaloId);
            // ──────────────────────────────────────────────────────────────

            const service = await getService(typeof auth === 'string' ? auth : JSON.stringify(auth), isReconnection);
            const result = await fn(service, rest);
            return { success: true, response: result };
        } catch (error: any) {
            const errorMsg = error?.message || error?.toString() || 'Unknown error';
            Logger.error(`[zaloIpc] ${channel} error:`, error);
            // Zalo error code (ZaloApiError.code, e.g. joinGroupLink: 178 already a member, 172 group full) so the UI can classify it;
            // previously it was dropped, so the checks on `res.errorCode` never matched
            const errorCode = typeof error?.code === 'number' ? error.code : undefined;
            return { success: false, error: errorMsg, ...(errorCode !== undefined ? { errorCode } : {}) };
        }
    };

    // Register in both ipcMain and our handler registry
    ipcMain.handle(channel, handler);
    ipcHandlerRegistry.set(channel, handler);
}

export function registerZaloIpc() {
    // ─── Messages ────────────────────────────────────────────────────────
    wrap('zalo:sendMessage', (s, p) =>
        s.sendMessage(p.message, p.threadId, p.type, p.typeMessage, p.quote, p.mentions, p.styles)
    );

    wrap('zalo:sendSticker', (s, p) =>
        s.sendSticker(p.stickerId, p.threadId, p.type)
    );

    // Newer UI callers use `threadType`, while older chat/forward flows use
    // `type`. Always resolve both here so group media is never sent to the
    // individual-chat endpoint by accident.
    wrap('zalo:sendImage', (s, p) =>
        s.sendImage(FileStorageService.resolveAbsolutePath(p.filePath), p.threadId, p.type ?? p.threadType, p.message, p.quote)
    );

    wrap('zalo:sendImages', (s, p) =>
        s.sendImages((p.filePaths || []).map((fp: string) => FileStorageService.resolveAbsolutePath(fp)), p.threadId, p.type ?? p.threadType, p.quote)
    );

    wrap('zalo:sendFile', (s, p) =>
        s.sendFile(FileStorageService.resolveAbsolutePath(p.filePath), p.threadId, p.type ?? p.threadType, p.quote)
    );

    wrap('zalo:sendVoice', (s, p) =>
        s.sendVoice(p.options, p.threadId, p.type, p.quote)
    );

    wrap('zalo:uploadVoiceFile', (s, p) =>
        s.uploadVoiceFile(FileStorageService.resolveAbsolutePath(p.voicePath), p.threadId, p.type)
    );

    wrap('zalo:sendVideo', (s, p) =>
        s.sendVideo(p.options, p.threadId, p.type, p.quote)
    );

    // The relative path stored in the DB (media/…) as in sendImage/sendFile: forwarding a downloaded video uses this form.
    wrap('zalo:uploadVideoThumb', (s, p) =>
        s.uploadVideoThumb(FileStorageService.resolveAbsolutePath(p.thumbPath), p.threadId, p.type)
    );

    wrap('zalo:uploadVideoFile', (s, p) =>
        s.uploadVideoFile(FileStorageService.resolveAbsolutePath(p.videoPath), p.threadId, p.type)
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
        s.forwardMessage(p.payload, p.threadIds, p.type)
    );

    // ─── Message history ────────────────────────────────────────────────
    wrap('zalo:getMessageHistory', (s, p) =>
        s.getMessageHistory(p.threadId, p.type, p.lastMsgId, p.count)
    );

    wrap('zalo:getGroupChatHistory', async (s, p) => {
        let result: any;
        try {
            // p.cursor: { lastMsgId, isOld } from the previous call → the next older pages
            result = await s.getGroupChatHistory(p.groupId, p.count ?? 500, p.cursor ?? null);
        } catch (apiErr: any) {
            Logger.warn(`[zaloIpc] getGroupChatHistory API error for group ${p.groupId}: ${apiErr.message}`);
            return { groupMsgsCount: 0, error: apiErr.message };
        }
        // { groupMsgs: GroupMessage[], hasMore, cursor }: each GroupMessage is { data, threadId, type, isSelf, ... }
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
        return { groupMsgsCount: msgs.length, hasMore: !!result?.hasMore, cursor: result?.cursor ?? null };
    });

    // ─── Friends ───────────────────────────────────────────────────────────
    wrap('zalo:getFriends', (s) => s.getAllFriends());

    wrap('zalo:findUser', (s, p) =>
        s.findUser(p.phone || p.username)
    );

    wrap('zalo:getUserInfo', (s, p) =>
        s.getUserInfo(p.userId)
    );

    // Bulk refresh names/avatars for contacts already in the DB (by UID): see refreshContactsInfo().
    wrap('zalo:refreshContactsInfo', (s, p) => refreshContactsInfo(s, p));

    // Get the session context of the login (uid, phone, loginInfo, ...)
    {
        const handler = async (_event: any, params: any) => {
            try {
                const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
                if (activeWs?.type === 'remote' && !params?._fromRelay) {
                    return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, 'zalo:getContext', params);
                }
                let { auth, _fromRelay } = params;
            if (!auth) return { success: false, error: 'Missing auth' };
            const zaloId = resolveZaloId(auth);
            auth = resolveAuthFromConnection(auth, zaloId);
            const service = await getService(typeof auth === 'string' ? auth : JSON.stringify(auth));
            const context = service.getContext();

            // Serialize the cookie into a plain object to avoid the "object could not be cloned" error
            let cookieSerialized: any = null;
            try {
                cookieSerialized = context.cookie?.serializeSync
                    ? context.cookie.serializeSync()
                    : context.cookie?.toJSON?.()
                    ?? null;
            } catch (_) {}

            // Return only the serializable fields (drop the CookieJar object)
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

            // Full log for debugging
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
        s.getAliasList(p.count || 200, p.page || 1)
    );

    wrap('zalo:getFriendRequestStatus', (s, p) =>
        s.getFriendRequestStatus(p.userId)
    );

    wrap('zalo:blockUser', (s, p) => s.blockUser(p.userId));

    wrap('zalo:unblockUser', (s, p) => s.unblockUser(p.userId));

    wrap('zalo:getRelatedFriendGroup', (s, p) => s.getRelatedFriendGroup(p.userId));

    // ─── Groups ────────────────────────────────────────────────────────────
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

    wrap('zalo:joinGroupLink', (s, p) =>
        s.joinGroupLink(p.link)
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

    // ─── Conversations ────────────────────────────────────────────────────
    wrap('zalo:getPinConversations', (s) => s.getPinConversations());

    // ─── Access status (ZL-01) / self-deleting messages (ZL-05): Deplao SRS ───
    wrap('zalo:getPresence', (s, p) => s.getPresence(String(p.userId || ''), !!p.force));
    wrap('zalo:getFriendOnlines', (s, p) => s.getFriendOnlineIds(!!p.force));
    wrap('zalo:getAutoDeleteChats', (s) => s.syncAutoDeleteChats());
    wrap('zalo:setAutoDeleteChat', (s, p) => s.setAutoDeleteChat(Number(p.ttl), String(p.threadId || ''), p.type ?? p.threadType));

    // ─── Privacy settings (ZL-02): employee machines need the settings_accounts permission (proxyActionPolicy) ───
    wrap('zalo:getAccountSettings', (s) => s.getAccountSettings());
    wrap('zalo:updateAccountSetting', (s, p) => s.updateAccountSetting(String(p.key || ''), Number(p.value), p.previous));

    // ─── Conversations hidden by PIN (ZL-03): the PIN is checked in Boss's main process, MD5 never leaves main; changing the PIN needs settings_accounts ───
    wrap('zalo:hiddenStatus', (s, p) => s.hiddenConversationStatus(!!p.force));
    wrap('zalo:hiddenUnlock', (s, p) => s.unlockHiddenConversations(String(p.pin || '')));
    wrap('zalo:setConversationHidden', (s, p) => s.setConversationHidden(String(p.threadId || ''), p.type ?? p.threadType, !!p.hidden));
    wrap('zalo:hiddenSetPin', (s, p) => s.setHiddenConversationPin(String(p.pin || ''), p.oldPin ? String(p.oldPin) : undefined));
    wrap('zalo:hiddenResetPin', (s) => s.resetHiddenConversationPin());

    // ─── Zalo Business product catalog (ZL-04): reading = Chat permission, writing = CRM permission (proxyActionPolicy) ───
    wrap('zalo:getCatalogs', (s, p) => s.getCatalogs(Number(p.page) || 0, Number(p.limit) || 20));
    wrap('zalo:createCatalog', (s, p) => s.createCatalog(String(p.name || '')));
    wrap('zalo:updateCatalog', (s, p) => s.updateCatalog(String(p.catalogId || ''), String(p.name || '')));
    wrap('zalo:deleteCatalog', (s, p) => s.deleteCatalog(String(p.catalogId || '')));
    wrap('zalo:getCatalogProducts', (s, p) => s.getCatalogProducts(String(p.catalogId || ''), Number(p.page) || 0, Number(p.limit) || 100));
    wrap('zalo:createCatalogProduct', (s, p) => s.createCatalogProduct(p.product || {}));
    wrap('zalo:updateCatalogProduct', (s, p) => s.updateCatalogProduct(p.product || {}));
    wrap('zalo:deleteCatalogProducts', (s, p) =>
        s.deleteCatalogProducts(String(p.catalogId || ''), Array.isArray(p.productIds) ? p.productIds.map(String) : []));
    wrap('zalo:uploadProductPhoto', (s, p) => s.uploadProductPhoto(FileStorageService.resolveAbsolutePath(p.photoPath)));

    wrap('zalo:setPinConversation', (s, p) =>
        s.setPinConversations(p.conversations, p.isPin)
    );

    wrap('zalo:setMute', (s, p) =>
        s.setMute(p.threadId, p.threadType ?? 0, p.duration, p.action)
    );

    // ─── Labels ───────────────────────────────────────────────────────────
    // getLabels uses plain HTTP and does not need an active WS connection
    // → does not use wrap() so it is not blocked by the !zaloId guard
    {
        const handler = async (_event: any, params: any) => {
            try {
                const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
                if (activeWs?.type === 'remote' && !params?._fromRelay) {
                    if (!HttpConnectionManager.getInstance().isConnected(activeWs.id)) {
                        return { success: false, error: tr('Chưa kết nối tới BOSS'), response: { labelData: [] } };
                    }
                    return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, 'zalo:getLabels', params);
                }
                let { auth, _fromRelay } = params;
                if (!auth) return { success: false, error: 'Missing auth' };
                const zaloId = resolveZaloId(auth);
                auth = resolveAuthFromConnection(auth, zaloId);
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
                    if (!HttpConnectionManager.getInstance().isConnected(activeWs.id)) {
                        return { success: false, error: tr('Chưa kết nối tới BOSS') };
                    }
                    return await HttpConnectionManager.getInstance().proxyAction(activeWs.id, 'zalo:updateLabels', params);
                }
                let { auth, isReconnection = false, _fromRelay, labelData, version, labelDiffs, ...rest } = params;
            if (!auth) return { error: 'Missing auth' };

            const zaloId = resolveZaloId(auth);
            if (!isReconnection && !zaloId) {
                Logger.warn(`[zaloIpc] Blocked zalo:updateLabels: no active connection`);
                return { success: false, error: 'Tài khoản chưa kết nối.' };
            }

            auth = resolveAuthFromConnection(auth, zaloId);
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

    // ─── GIF tab of the sticker panel (Giphy through Zalo) ─────────────────
    wrap('zalo:getGifCategories', (s) => s.getGifCategories());

    wrap('zalo:getGifs', (s, p) =>
        s.getGifs(String(p.keyword || ''), Number(p.offset) || 0, Number(p.limit) || 30)
    );

    wrap('zalo:sendGif', (s, p) =>
        s.sendGif(p.urls, p.threadId, p.type, p.quote ?? null)
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

    // ─── Quick messages ───────────────────────────────────────────────────────
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

    // ─── Group notes ─────────────────────────────────────────────────────────
    wrap('zalo:createNote', (s, p) =>
        s.createNote({ title: p.title, pinAct: p.pinAct }, p.groupId)
    );

    wrap('zalo:editNote', (s, p) =>
        s.editNote({ title: p.title, topicId: p.topicId, pinAct: p.pinAct }, p.groupId)
    );

    // ─── Reminders ─────────────────────────────────────────────────────────
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

    // Reminder card: Zalo sends long titles cut, the whole one comes from the group board once and is saved in the message
    wrap('zalo:resolveReminderTitle', (s, p) =>
        resolveZaloReminderTitle(s, p.msgId, p.threadId)
    );

    // ─── Read events ────────────────────────────────────────────────────
    wrap('zalo:sendSeenEvent', (s, p) =>
        s.sendSeenEvent(p.messages, p.type)
    );

    // "đang gõ" (typing) status: shared by the UI, Public API v1 and plugins.
    wrap('zalo:sendTyping', (s, p) =>
        s.sendTypingEvent(p.threadId, p.type ?? p.threadType)
    );

    // ─── Send bank card ─────────────────────────────────────────────────────
    wrap('zalo:sendBankCard', (s, p) =>
        s.sendBankCard(p.payload, p.threadId, p.type)
    );
}
