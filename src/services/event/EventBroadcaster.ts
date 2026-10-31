import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import Logger from '../../utils/Logger';
import { normalizeZaloMessageImages } from '../../utils/zalo/zaloImageUrl';
import DatabaseService from '../database/DatabaseService';
import { groupEventActorId, groupEventActorText, profileFromUserInfo } from '../../shared/zalo/zaloGroupEventActor';
import FileStorageService from '../file/FileStorageService';
import { groupAdminRole, groupOwnerRole } from '../../shared/chat/groupMemberRoles';
import { zaloReactionIconToEmoji } from '../../shared/zalo/zaloReactions';
import { applyZaloClearUnread, type ZaloClearUnread } from '../zalo/zaloReadElsewhere';

/** Callback để invalidate group cache trong ZaloLoginHelper (tránh circular import) */
let _invalidateGroupCacheFn: ((zaloId: string, groupId: string) => void) | null = null;
export function registerGroupCacheInvalidator(fn: (zaloId: string, groupId: string) => void) {
    _invalidateGroupCacheFn = fn;
}

/**
 * EventBroadcaster - Thay thế ApiService webhook bằng Electron IPC events
 * Broadcast Zalo events từ main process → renderer process
 */
/** Một dòng thông báo nhóm đang chờ tra tên người thực hiện (nhóm ẩn thành viên). */
interface GroupActorJob {
    zaloId: string;
    groupId: string;
    eventType: string;
    rawEvent: any;
    msgId: string;
    timestamp: number;
    actorId: string;
    placeholder: string;
}

class EventBroadcaster {
    private static window: BrowserWindow | null = null;
    /** Cache previous groupSetting per group to detect what changed in update_setting events */
    private static previousGroupSettings = new Map<string, Record<string, number>>();
    /** Hooks đăng ký bởi WorkflowEngineService để nhận event trước renderer */
    private static beforeSendHooks: Map<string, Array<(data: any) => void>> = new Map();

    /**
     * Some Zalo clients surface an undo control payload on the ordinary
     * `message`/`old_messages` stream as well as the dedicated `undo` stream.
     * It is metadata, never a chat message, and must not be persisted as a
     * JSON text bubble.
     */
    private static getUndoControlPayload(message: any): { msgId: string; threadId: string } | null {
        const data = message?.data || message || {};
        const candidates = [data?.content, message?.content, data];

        for (const rawCandidate of candidates) {
            let payload = rawCandidate;
            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch { continue; }
            }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;

            const msgId = payload.globalMsgId || payload.cliMsgId || '';
            const hasUndoSignature = !!msgId && (
                Object.prototype.hasOwnProperty.call(payload, 'deleteMsg') ||
                Object.prototype.hasOwnProperty.call(payload, 'srcId') ||
                Object.prototype.hasOwnProperty.call(payload, 'destId')
            );
            if (!hasUndoSignature) continue;

            // `srcId` can be an internal sender object, not a conversation ID.
            // Prefer the listener-normalized threadId and only use explicit
            // thread fields as fallbacks.
            return {
                msgId: String(msgId),
                threadId: String(message?.threadId || data?.threadId || data?.idTo || ''),
            };
        }
        return null;
    }

    /**
     * Pre-seed the settings cache for a group so the FIRST update_setting event
     * can diff against a known baseline.  Call this BEFORE invoking updateGroupSettings.
     */
    public static seedGroupSettings(zaloId: string, groupId: string, settings: Record<string, number>): void {
        const cacheKey = `${zaloId}_${groupId}`;
        // Only seed if there is no existing entry – don't overwrite a fresher cache
        if (!this.previousGroupSettings.has(cacheKey) && Object.keys(settings).length > 0) {
            // Cap cache size to prevent unbounded memory growth
            if (this.previousGroupSettings.size > 1000) {
                const firstKey = this.previousGroupSettings.keys().next().value;
                if (firstKey) this.previousGroupSettings.delete(firstKey);
            }
            this.previousGroupSettings.set(cacheKey, { ...settings });
        }
    }

    public static setWindow(win: BrowserWindow): void {
        this.window = win;
    }

    /** Generic channel emit - dùng bởi CRMQueueService và các service khác */
    public static emit(channel: string, data: any): void {
        this.send(channel, data);
    }

    // ─── Workspace-aware helpers ──────────────────────────────────────
    private static resolveBossContext(): { bossDbPath: string | null; activeIsDefault: boolean } {
        try {
            const WorkspaceManager = require('../../utils/app/WorkspaceManager').default;
            const wm = WorkspaceManager.getInstance();
            const activeIsDefault = wm.getActiveWorkspaceId() === 'default';
            if (!activeIsDefault) {
                const defaultWs = wm.getWorkspaceById('default');
                if (defaultWs) {
                    return { bossDbPath: wm.resolveDbPath(defaultWs.dbPath || 'deplao-tool.db'), activeIsDefault: false };
                }
            }
            return { bossDbPath: null, activeIsDefault: true };
        } catch {
            return { bossDbPath: null, activeIsDefault: true };
        }
    }

    public static runOnBossDb(fn: (db: DatabaseService) => void): void {
        this.withBossDb(fn);
    }

    /** Như runOnBossDb nhưng trả về kết quả của `fn` (fn phải đồng bộ). */
    public static withBossDb<T>(fn: (db: DatabaseService) => T): T {
        const { bossDbPath } = this.resolveBossContext();
        const db = DatabaseService.getInstance();
        return bossDbPath ? db.withDbPath(bossDbPath, () => fn(db)) : fn(db);
    }

    private static sendAware(channel: string, data: any): void {
        const { activeIsDefault } = this.resolveBossContext();
        if (activeIsDefault) {
            this.send(channel, data);
        } else {
            this.fireHooksOnly(channel, data);
        }
    }

    /**
     * Đăng ký hook nhận event trước khi gửi về renderer.
     * WorkflowEngineService dùng để trigger workflow.
     * Returns an unsubscribe function to remove the hook.
     */
    public static onBeforeSend(channel: string, callback: (data: any) => void): () => void {
        if (!this.beforeSendHooks.has(channel)) {
            this.beforeSendHooks.set(channel, []);
        }
        const hooks = this.beforeSendHooks.get(channel)!;
        // Prevent duplicate registration of the same function reference
        if (!hooks.includes(callback)) {
            hooks.push(callback);
        }
        // Return unsubscribe function
        return () => {
            const arr = this.beforeSendHooks.get(channel);
            if (arr) {
                const idx = arr.indexOf(callback);
                if (idx >= 0) arr.splice(idx, 1);
            }
        };
    }

    /**
     * Remove all before-send hooks (called on workspace switch to prevent accumulation).
     */
    public static clearBeforeSendHooks(): void {
        this.beforeSendHooks.clear();
    }

    /** Convert BigInt → string recursively để Electron IPC serialize được */
    private static sanitizeBigInt(obj: any): any {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj === 'bigint') return String(obj);
        if (Array.isArray(obj)) return obj.map(EventBroadcaster.sanitizeBigInt);
        if (typeof obj === 'object') {
            const result: any = {};
            for (const key of Object.keys(obj)) {
                result[key] = EventBroadcaster.sanitizeBigInt(obj[key]);
            }
            return result;
        }
        return obj;
    }

    private static send(channel: string, data: any): void {
        // Fire before-send hooks (sync, không chặn send)
        const hooks = this.beforeSendHooks.get(channel);
        const message = data?.message || data || {};
        const msgData = message?.data || data?.data || {};
        const messageChannel = data?.channel || message?.channel || msgData?.channel || '';
        const threadId = String(message?.threadId || data?.threadId || msgData?.threadId || msgData?.idTo || '');
        // if (channel === 'event:message' && messageChannel === 'telegram_user' && threadId.startsWith('-100')) {
        //     Logger.log(
        //         `[TG:channel-realtime] EVENT_BROADCASTER_DISPATCH | account=${data?.zaloId || data?.accountId || ''}` +
        //         ` chatId=${threadId} msgId=${msgData?.msgId || data?.msgId || ''} hooks=${hooks?.length || 0}`,
        //     );
        // }
        if (hooks && hooks.length > 0) {
            for (const hook of hooks) {
                try {
                    hook(data);
                } catch (error: any) {
                    // Do not let a workflow/relay hook stop the renderer event,
                    // but never swallow the failure: doing so makes a message
                    // visibly arrive while its automation appears to vanish.
                    Logger.error(`[EventBroadcaster] before-send hook failed event=${channel}: ${error?.message || String(error)}`);
                }
            }
        }
        if (this.window && !this.window.isDestroyed()) {
            // Sanitize BigInt trước khi gửi qua IPC
            const safeData = EventBroadcaster.sanitizeBigInt(data);
            this.window.webContents.send(channel, safeData);
        }
    }

    /**
     * Send directly to renderer WITHOUT firing onBeforeSend hooks.
     * Used by HttpClientService to avoid infinite relay loop:
     *   Boss relay → Employee handlePushedEvent → send → hook → relay → loop!
     */
    public static sendDirect(channel: string, data: any): void {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send(channel, data);
        }
    }

    /**
     * Fire onBeforeSend hooks ONLY - do NOT send to renderer.
     * Used when boss webhook fires while an employee workspace is active:
     * hooks relay the event to employees, but the renderer is showing
     * the employee workspace (employee's handlePushedEvent sends to renderer).
     */
    public static fireHooksOnly(channel: string, data: any): void {
        const hooks = this.beforeSendHooks.get(channel);
        if (hooks && hooks.length > 0) {
            for (const hook of hooks) {
                try {
                    hook(data);
                } catch (error: any) {
                    Logger.error(`[EventBroadcaster] hooks-only hook failed event=${channel}: ${error?.message || String(error)}`);
                }
            }
        }
    }

    /**
     * Extract human-readable text from a webchat/msginfo.actionlist notification.
     * Mirrors the PHP server-side logic:
     *   - Parse params.msg.vi (Vietnamese localised template with %1$s … placeholders)
     *   - Substitute placeholders from simpleInfos[].dpn  (simple single-user events)
     *     or highLightsV2[].dpn (multi-user / reminder events)
     *   - Fall back to the pre-formatted content.title when params cannot be parsed
     */
    private static extractActionlistText(content: any): string {
        if (!content || typeof content !== 'object') return '';
        try {
            const params = typeof content.params === 'string'
                ? JSON.parse(content.params)
                : (content.params || {});

            const template: string = params?.msg?.vi || '';
            if (template) {
                let values: string[] = [];

                // simpleInfos → single name replacement (most setting-change events)
                if (Array.isArray(params.simpleInfos) && params.simpleInfos.length > 0) {
                    values = params.simpleInfos.map((i: any) => String(i.dpn || ''));
                }
                // highLightsV2 → multi-name replacement (reminders, bulk actions, etc.)
                else if (Array.isArray(params.highLightsV2) && params.highLightsV2.length > 0) {
                    values = params.highLightsV2.map((h: any) => String(h.dpn || ''));
                }

                if (values.length > 0) {
                    // Replace %1$s, %2$s … (PHP sprintf positional format)
                    const formatted = template.replace(/%(\d+)\$s/g, (_: string, n: string) =>
                        values[parseInt(n, 10) - 1] || ''
                    );
                    if (formatted) return formatted;
                }

                // Template exists but no values to substitute – return as-is
                if (template && !template.includes('%')) return template;
            }
        } catch {}

        // Final fallback: Zalo already pre-formats the title field
        return String(content.title || '');
    }

    /**
     * Broadcast tin nhắn mới đến renderer
     * Auto-save vào database
     *
     * @param options.silent  When true (old messages / group history reload):
     *   - Skip entirely if message already exists in DB (avoid duplicate broadcast)
     *   - For NEW messages, mark `_silent` flag so renderer skips sound/notification
     */
    public static async broadcastMessage(zaloId: string, message: any, options?: { silent?: boolean; fromRelay?: boolean }): Promise<void> {
        try {
            // Ảnh JPEG XL (Zalo điện thoại bản mới) → URL bản JPG trước khi lưu DB / tải về / gửi renderer.
            normalizeZaloMessageImages(message);
            const undoControl = this.getUndoControlPayload(message);
            if (undoControl) {
                Logger.log(`[EventBroadcaster] Detected undo control payload on message stream: recalled msgId=${undoControl.msgId} threadId=${undoControl.threadId || '-'} source=${options?.silent ? 'history' : 'realtime'}`);
                this.broadcastUndo(zaloId, undoControl.msgId, undoControl.threadId);
                return;
            }

            // ─── Resolve the correct DB path for saving ───────────────────────
            // Boss webhook (fromRelay=false): ALWAYS save to the default workspace DB.
            // This ensures the boss DB (source of truth) gets every message,
            // even when the user is viewing an employee workspace.
            let bossDbPath: string | null = null;
            let activeIsDefault = true;
            if (!options?.fromRelay) {
                try {
                    const WorkspaceManager = require('../../utils/app/WorkspaceManager').default;
                    const wm = WorkspaceManager.getInstance();
                    activeIsDefault = wm.getActiveWorkspaceId() === 'default';
                    if (!activeIsDefault) {
                        const defaultWs = wm.getWorkspaceById('default');
                        if (defaultWs) {
                            bossDbPath = wm.resolveDbPath(defaultWs.dbPath || 'deplao-tool.db');
                        }
                    }
                } catch {}
            }

            // ─── Silent mode: skip if message already exists in DB ─────────────
            if (options?.silent) {
                const msgId = message.data?.msgId;
                if (msgId && DatabaseService.getInstance().hasMessage(zaloId, String(msgId))) {
                    return; // Already in DB → skip entirely (no save, no event, no download)
                }
                // New message but from getGroupChatHistory (lịch sử) → mark silent
                message._silent = true;
            }

            // ─── Zalo giao trùng một tin (id khác, cùng người gửi + cliMsgId + nội dung — thường tin nhóm) ─────────
            // Bản đầu đã lưu → bỏ hẳn bản sau: không lưu, không gửi giao diện, không chạy workflow / webhook
            try {
                const dbs = DatabaseService.getInstance();
                const duplicate = bossDbPath
                    ? dbs.withDbPath(bossDbPath, () => dbs.isDuplicateZaloDelivery(zaloId, message))
                    : dbs.isDuplicateZaloDelivery(zaloId, message);
                if (duplicate) {
                    Logger.log(`[EventBroadcaster] Bỏ tin Zalo giao trùng: msgId=${message.data?.msgId} cliMsgId=${message.data?.cliMsgId} threadId=${message.threadId}`);
                    return;
                }
            } catch { /* kiểm tra lỗi → xử lý như tin mới */ }

            // ─── Early-detect webchat/msginfo.actionlist notifications ───────────────
            // Zalo sends general conversation notifications (group setting changes,
            // reminders, member actions, etc.) as regular "message" events with
            //   msgType = "webchat"  and  content.action = "msginfo.actionlist"
            // These must be displayed as centred notification pills for ALL thread types,
            // NOT as regular message bubbles.
            const earlyMsgType = String(message.data?.msgType || '');
            const earlyContent = message.data?.content;
            if (
                earlyMsgType === 'webchat' &&
                earlyContent && typeof earlyContent === 'object' &&
                (earlyContent as any).action === 'msginfo.actionlist'
            ) {
                const systemText = EventBroadcaster.extractActionlistText(earlyContent);
                if (systemText && message.threadId) {
                    const sysMsgId = String(message.data?.msgId || `sys_wchat_${Date.now()}`);
                    const sysTs    = parseInt(String(message.data?.ts)) || Date.now();
                    try {
                        DatabaseService.getInstance().saveSystemMessage(
                            zaloId, message.threadId, sysMsgId, systemText, sysTs
                        );
                    } catch {}

                    // ── Auto-pin/unpin from actionlist webhook ──────────────────────
                    // Zalo gửi webhook này khi ai đó ghim/bỏ ghim tin nhắn trong hội thoại
                    // actionType = "action.groupchat.jump.msg" → ghim; title chứa "bỏ ghim" → unpin
                    try {
                        const wcParams = typeof (earlyContent as any).params === 'string'
                            ? JSON.parse((earlyContent as any).params)
                            : ((earlyContent as any).params || {});
                        const actions: any[] = wcParams?.actions || [];
                        const pinAction = actions.find((a: any) =>
                            a?.actionType === 'action.groupchat.jump.msg' ||
                            String(a?.actionType || '').includes('jump.msg')
                        );
                        const titleText = String((earlyContent as any).title || '');
                        const isUnpin = titleText.toLowerCase().includes('bỏ ghim') ||
                                        titleText.toLowerCase().includes('unpin') ||
                                        titleText.toLowerCase().includes('removed pin');

                        if (pinAction?.actionData) {
                            const actionData = typeof pinAction.actionData === 'string'
                                ? JSON.parse(pinAction.actionData)
                                : pinAction.actionData;
                            const pinnedMsgId = String(actionData?.global_msg_id || actionData?.client_msg_id || '');

                            if (pinnedMsgId && pinnedMsgId !== '0') {
                                const db = DatabaseService.getInstance();
                                if (isUnpin) {
                                    db.unpinMessage(zaloId, message.threadId, pinnedMsgId);
                                    Logger.log(`[EventBroadcaster] Auto-unpinned msg ${pinnedMsgId} in thread ${message.threadId}`);
                                } else {
                                    // Lấy tên người ghim từ highLightsV2
                                    const senderName: string = (wcParams?.highLightsV2?.[0]?.dpn ||
                                        wcParams?.simpleInfos?.[0]?.dpn || '') as string;
                                    const senderId = String(message.data?.uidFrom || message.data?.userId || '');

                                    // Thử lấy tin nhắn gốc từ DB để có preview đầy đủ
                                    const origMsg = db.getMessageById(zaloId, pinnedMsgId);
                                    if (origMsg) {
                                        // Build pin từ tin nhắn gốc
                                        let previewText = '';
                                        let previewImage = '';
                                        const mt = origMsg.msg_type || '';
                                        try {
                                            const lp = JSON.parse(origMsg.local_paths || '{}');
                                            previewImage = lp.main || lp.hd || '';
                                        } catch {}
                                        if (!previewImage && (mt === 'photo' || mt === 'image')) {
                                            try {
                                                const p = JSON.parse(origMsg.content || '{}');
                                                previewImage = p?.params?.hd || p?.params?.rawUrl || p?.href || p?.thumb || '';
                                            } catch {}
                                        }
                                        if (!previewImage) {
                                            try {
                                                const p = JSON.parse(origMsg.content || '{}');
                                                previewText = p?.msg || p?.title || String(origMsg.content || '').slice(0, 200);
                                            } catch { previewText = String(origMsg.content || '').slice(0, 200); }
                                        }
                                        db.pinMessage(zaloId, message.threadId, {
                                            msgId: pinnedMsgId,
                                            msgType: origMsg.msg_type,
                                            content: origMsg.content,
                                            previewText,
                                            previewImage,
                                            senderId: origMsg.sender_id,
                                            senderName,
                                            timestamp: origMsg.timestamp,
                                        });
                                    } else {
                                        // Không có tin gốc → lưu với preview tối thiểu
                                        const msgTypeFromAction = actionData?.msg_type ? String(actionData.msg_type) : 'unknown';
                                        const isPhotoType = msgTypeFromAction === '32' || titleText.toLowerCase().includes('hình ảnh') || titleText.toLowerCase().includes('photo');
                                        db.pinMessage(zaloId, message.threadId, {
                                            msgId: pinnedMsgId,
                                            msgType: isPhotoType ? 'photo' : 'text',
                                            content: '',
                                            previewText: isPhotoType ? '' : titleText,
                                            previewImage: '',
                                            senderId,
                                            senderName,
                                            timestamp: sysTs,
                                        });
                                    }
                                    Logger.log(`[EventBroadcaster] Auto-pinned msg ${pinnedMsgId} in thread ${message.threadId} by ${senderName}`);
                                }

                                // Notify renderer to reload pins
                                EventBroadcaster.send('event:pinsUpdated', {
                                    zaloId,
                                    threadId: message.threadId,
                                });
                            }
                        }
                    } catch (pinErr: any) {
                        Logger.warn(`[EventBroadcaster] Auto-pin parse error: ${pinErr.message}`);
                    }
                    // ── End auto-pin ────────────────────────────────────────────────

                    // Re-use event:groupEvent channel - it handles any threadId, not just groups
                    this.send('event:groupEvent', {
                        zaloId,
                        groupId:   message.threadId,
                        eventType: 'webchat_info',
                        data:      {},
                        systemText,
                        msgId:     sysMsgId,
                        timestamp: sysTs,
                    });
                }
                return; // Do NOT process as a normal message bubble
            }
            // ────────────────────────────────────────────────────────────────────────

            // ─── group.poll vote event: update existing message, don't insert new ──
            if (String(message.data?.msgType || '') === 'group.poll') {
                try {
                    const rawContent = message.data?.content;
                    const contentObj = typeof rawContent === 'object' ? rawContent : JSON.parse(rawContent || '{}');
                    const action: string = contentObj?.action || '';
                    if (action === 'vote') {
                        const params = typeof contentObj.params === 'string'
                            ? JSON.parse(contentObj.params)
                            : (contentObj.params || {});
                        const pollId = String(params.pollId || '');
                        const question: string = params.question || '';
                        const voterName: string = params.dName || (message.data as any)?.dName || '';
                        const timestamp = parseInt(message.data?.ts) || Date.now();
                        const threadId: string = message.threadId || '';
                        const isSent: boolean = message.isSelf === true;
                        const newContent = typeof rawContent === 'object'
                            ? JSON.stringify(rawContent)
                            : String(rawContent || '');

                        if (pollId && threadId) {
                            const updated = DatabaseService.getInstance().updatePollVoteMessage(
                                zaloId, threadId, pollId, newContent, voterName, question, timestamp, isSent
                            );
                            if (updated) {
                                // Notify renderer to refresh poll + contact list
                                this.send('event:pollVote', {
                                    zaloId,
                                    threadId,
                                    pollId,
                                    voterName,
                                    question,
                                    timestamp,
                                });
                                Logger.log(`[EventBroadcaster] poll vote updated: pollId=${pollId} by ${voterName}`);
                                return; // Don't insert as new message
                            }
                        }
                    }
                } catch (pollErr: any) {
                    Logger.warn(`[EventBroadcaster] group.poll intercept error: ${pollErr.message}`);
                }
            }
            // ─────────────────────────────────────────────────────────────────────────

            // Lưu vào database - always target the boss (default) workspace DB
            if (bossDbPath) {
                DatabaseService.getInstance().withDbPath(bossDbPath, () => {
                    DatabaseService.getInstance().saveMessage(zaloId, message);
                    // markAsRead + updateContactProfile also in the correct DB
                    if (message.isSelf && message.threadId) {
                        try { DatabaseService.getInstance().markAsRead(zaloId, message.threadId); } catch {}
                    }
                    if (!message.isSelf && message.type !== 1) {
                        const dName: string = (message.data as any)?.dName || '';
                        const senderInfo = (message.data as any)?.senderInfo;
                        const displayName = senderInfo?.displayName || senderInfo?.zaloName || senderInfo?.name || dName || '';
                        const avatarUrl = senderInfo?.avatar || senderInfo?.avatarUrl || '';
                        if (displayName) {
                            DatabaseService.getInstance().updateContactProfile(zaloId, message.threadId, displayName, avatarUrl);
                        }
                    }
                    if (message.type === 1) {
                        const groupId = message.threadId || '';
                        const groupInfo = (message.data as any)?.groupInfo || (message.data as any)?.group;
                        const groupName: string = groupInfo?.name || groupInfo?.groupName || (message.data as any)?.groupName || '';
                        const groupAvt: string = groupInfo?.avt || groupInfo?.avatar || '';
                        if (groupId && groupName) {
                            DatabaseService.getInstance().updateContactProfile(zaloId, groupId, groupName, groupAvt);
                        }
                    }
                });
                Logger.log(`[EventBroadcaster] Saved message to boss DB via withDbPath: ${bossDbPath}`);
            } else {
                await DatabaseService.getInstance().saveMessage(zaloId, message);
            }

            // ── Check if this message was sent by an employee (pending from relay) ──
            // This runs right after saveMessage so the row exists in DB
            if (message.data?.msgId) {
                const isSelfMsg = message.isSelf === true;
                if (!isSelfMsg) {
                    Logger.log(`[EventBroadcaster] ⚠️ message.isSelf=${message.isSelf} for msgId="${message.data.msgId}" - checking pending map anyway`);
                }
                try {
                    const HttpRelayService = require('../http/HttpRelayService').default;
                    Logger.log(`[EventBroadcaster] 🔍 Checking pendingEmployeeMsg: msgId="${message.data.msgId}", zaloId="${zaloId}", threadId="${message.threadId || ''}", isSelf=${message.isSelf}`);
                    const pendingEmp = HttpRelayService.consumePendingEmployeeMsg(message.data.msgId, zaloId, message.threadId || '', message.data?.cliMsgId || '');
                    Logger.log(`[EventBroadcaster] 🔍 consumePendingEmployeeMsg result: ${pendingEmp ? JSON.stringify({ employee_id: pendingEmp.employee_id, employee_name: pendingEmp.employee_name }) : 'NULL'}`);
                    if (pendingEmp) {
                        const empMsgId = String(message.data.msgId);
                        const db = DatabaseService.getInstance();
                        if (bossDbPath) {
                            db.withDbPath(bossDbPath, () => db.setMessageHandledByEmployeeFlexible(zaloId, empMsgId, pendingEmp.employee_id));
                        } else {
                            db.setMessageHandledByEmployeeFlexible(zaloId, empMsgId, pendingEmp.employee_id);
                        }
                        Logger.log(`[EventBroadcaster] Tagged message ${empMsgId} as sent by employee ${pendingEmp.employee_id} (${pendingEmp.employee_name})`);

                        // Inject handled_by_employee into the message object so the event carries it
                        if (!message.data._employeeInfo) {
                            message.data._employeeInfo = {
                                employee_id: pendingEmp.employee_id,
                                employee_name: pendingEmp.employee_name,
                                employee_avatar: pendingEmp.employee_avatar,
                            };
                        }

                        // Broadcast relay:messageSentByEmployee to local renderer
                        // (This ensures the UI updates even if the earlier broadcast was missed)
                        const senderPayload = {
                            zaloId,
                            threadId: message.threadId || '',
                            msgId: empMsgId,
                            employee_id: pendingEmp.employee_id,
                            employee_name: pendingEmp.employee_name,
                            employee_avatar: pendingEmp.employee_avatar,
                        };
                        this.emit('relay:messageSentByEmployee', senderPayload);
                    }
                } catch (empErr: any) {
                    Logger.warn(`[EventBroadcaster] pendingEmployeeMsg check error: ${empErr.message}`);
                }
            }

            // ── Debug: log bank card content để phân tích cấu trúc webhook ──
            const rawMsgTypeDbg = String(message.data?.msgType || '');
            if (rawMsgTypeDbg === 'chat.webcontent') {
                const bankContent = message.data?.content;
                const bankContentStr = typeof bankContent === 'object' ? JSON.stringify(bankContent) : String(bankContent || '');
                Logger.log(`[EventBroadcaster] 🏦 chat.webcontent content: ${bankContentStr.slice(0, 2000)}`);
            }

            // ── The following DB operations are SKIPPED when bossDbPath is set ──
            // (they were already done inside the withDbPath block above)
            if (!bossDbPath) {
                // Nếu là tin nhắn của chính mình (isSelf) → đánh dấu đã đọc ngay
                if (message.isSelf && message.threadId) {
                    try {
                        await DatabaseService.getInstance().markAsRead(zaloId, message.threadId);
                    } catch {}
                }

                // Nếu có thông tin tên trong message → lưu ngay vào DB
                if (!message.isSelf && message.type !== 1) {
                    const dName: string = (message.data as any)?.dName || '';
                    const senderInfo = (message.data as any)?.senderInfo;
                    const displayName = senderInfo?.displayName || senderInfo?.zaloName || senderInfo?.name || dName || '';
                    const avatarUrl = senderInfo?.avatar || senderInfo?.avatarUrl || '';
                    if (displayName) {
                        DatabaseService.getInstance().updateContactProfile(
                            zaloId, message.threadId, displayName, avatarUrl
                        );
                        Logger.log(`[EventBroadcaster] Saved contact profile: ${message.threadId} → ${displayName}`);
                    }
                }

                // Cho group messages: cố gắng lấy tên nhóm từ groupInfo trong data
                if (message.type === 1) {
                    const groupId = message.threadId || '';
                    const groupInfo = (message.data as any)?.groupInfo || (message.data as any)?.group;
                    const groupName: string = groupInfo?.name || groupInfo?.groupName || (message.data as any)?.groupName || '';
                    const groupAvt: string = groupInfo?.avt || groupInfo?.avatar || '';
                    if (groupId && groupName) {
                        DatabaseService.getInstance().updateContactProfile(zaloId, groupId, groupName, groupAvt);
                        Logger.log(`[EventBroadcaster] Saved group profile: ${groupId} → ${groupName}`);
                    }
                }
            }

            // Group information is normally cached as a contact. Surface that
            // name on the event itself so every consumer, including workflow
            // templates, gets the same context even when Zalo omits it from a
            // message payload.
            if (message.type === 1 && !message.groupName) {
                const groupId = String(message.threadId || '');
                const cachedName = groupId
                    ? String(DatabaseService.getInstance().getContactById(zaloId, groupId)?.display_name || '')
                    : '';
                if (cachedName && cachedName !== groupId && !/^\d+$/.test(cachedName)) {
                    message.groupName = cachedName;
                }
            }

            // ─── Phân loại message: file hay ảnh ─────────────────────────────
            const contentRaw = message.data?.content;
            const rawMsgType = String(message.data?.msgType || '');
            const msgId = message.data?.msgId || '';
            // Zalo CDN can require the account's authenticated session even
            // when the copied CDN URL remains valid in a browser tab.
            const mediaAccount = DatabaseService.getInstance().getAccounts()
                .find(account => account.zalo_id === zaloId);
            const mediaCookies = mediaAccount?.cookies;
            const mediaUserAgent = mediaAccount?.user_agent;

            // Skip file/image downloads only for non-media message types
            // Do NOT skip when fromRelay: Boss needs to download media files
            // from Zalo CDN even for relayed messages, otherwise the Boss's
            // /api/media/ endpoint can't serve the file to employees.
            const SKIP_DOWNLOAD_MSG_TYPES = ['chat.ecard', 'group.poll'];
            const shouldSkipDownload = SKIP_DOWNLOAD_MSG_TYPES.includes(rawMsgType);

            // Card message (danh thiếp): chat.recommended / action contains "recommened"
            const CARD_MSG_TYPES = ['chat.recommended', 'chat.recommend'];
            const isCardMsg = CARD_MSG_TYPES.includes(rawMsgType) ||
                (contentRaw && typeof contentRaw === 'object' &&
                    String(contentRaw.action || '').includes('recommened'));

            // File message: share.file hoặc content có title + href (không có rawUrl/hd)
            // Loại trừ card messages để tránh download href=www.zaloapp.com
            // Video: chat.video.msg - download thumbnail + video file
            const isVideoMsg = rawMsgType === 'chat.video.msg' ||
                (contentRaw && typeof contentRaw === 'object' &&
                    contentRaw.href && String(contentRaw.href).includes('video') &&
                    contentRaw.thumb && !contentRaw.title);

            // Voice message: chat.voice - download audio file, KHÔNG phải ảnh/file
            const isVoiceMsg = rawMsgType === 'chat.voice';

            if (!shouldSkipDownload && isVoiceMsg && contentRaw && typeof contentRaw === 'object' && msgId) {
                const voiceHref = String(contentRaw.href || '');
                if (voiceHref) {
                    FileStorageService.downloadFile(zaloId, voiceHref, `voice_${msgId}.m4a`, mediaCookies, mediaUserAgent).then((localPath) => {
                        DatabaseService.getInstance().updateLocalPaths(zaloId, String(msgId), { file: localPath });
                        EventBroadcaster.send('event:localPath', {
                            zaloId, msgId: String(msgId), threadId: message.threadId,
                            localPaths: { file: localPath },
                        });
                        Logger.log(`[EventBroadcaster] Downloaded voice for msg ${msgId}: ${localPath}`);
                    }).catch((err) => Logger.warn(`[EventBroadcaster] Voice download failed for ${msgId}: ${err.message}`));
                }
            }

            if (!shouldSkipDownload && isVideoMsg && contentRaw && typeof contentRaw === 'object' && msgId) {
                const videoUrl = String(contentRaw.href || '');
                const thumbUrl = String(contentRaw.thumb || '');

                const downloads: Promise<void>[] = [];

                // Download thumbnail (ảnh đại diện) trước → hiển thị ngay
                if (thumbUrl) {
                    downloads.push(
                        FileStorageService.downloadImage(zaloId, thumbUrl, `thumb_${msgId}.jpg`, mediaCookies, mediaUserAgent).then((thumbPath) => {
                            if (thumbPath) {
                                DatabaseService.getInstance().updateLocalPaths(zaloId, String(msgId), { thumb: thumbPath });
                                EventBroadcaster.send('event:localPath', {
                                    zaloId, msgId: String(msgId), threadId: message.threadId,
                                    localPaths: { thumb: thumbPath },
                                });
                            }
                        }).catch((e) => Logger.warn(`[EventBroadcaster] Video thumb download failed for ${msgId}: ${e.message}`))
                    );
                }

                // Download video file (background, không block) — báo tiến độ: bong bóng hiện "2.1 / 5.0 MB" và chưa cho
                // mở trình phát tới khi tải xong (như Telegram)
                if (videoUrl) {
                    const { mediaProgressReporter } = require('../media/mediaProgress') as typeof import('../media/mediaProgress');
                    const progress = mediaProgressReporter(zaloId, String(message.threadId || ''), String(msgId));
                    progress.queued();
                    downloads.push(
                        FileStorageService.downloadVideo(zaloId, videoUrl, `vid_${msgId}.mp4`, mediaCookies, mediaUserAgent, progress.progress).then((videoPath) => {
                            if (videoPath) {
                                DatabaseService.getInstance().updateLocalPaths(zaloId, String(msgId), { file: videoPath });
                                EventBroadcaster.send('event:localPath', {
                                    zaloId, msgId: String(msgId), threadId: message.threadId,
                                    localPaths: { file: videoPath },
                                });
                                Logger.log(`[EventBroadcaster] Downloaded video for msg ${msgId}: ${videoPath}`);
                                progress.done();
                            } else {
                                progress.failed();
                            }
                        }).catch((e) => {
                            Logger.warn(`[EventBroadcaster] Video download failed for ${msgId}: ${e.message}`);
                            progress.failed();
                        })
                    );
                }

                Promise.allSettled(downloads).catch(() => {});
            }

            const FILE_MSG_TYPES = ['share.file', 'share.link', 'file'];

            // Helper: parse params field (may be string or object)
            const parseParams = (raw: any): any => {
                if (!raw) return {};
                if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
                return raw;
            };
            const contentParams = contentRaw && typeof contentRaw === 'object' ? parseParams(contentRaw.params) : {};

            const isFileMsg = !isCardMsg && !isVideoMsg && !isVoiceMsg && (FILE_MSG_TYPES.includes(rawMsgType) ||
                (contentRaw && typeof contentRaw === 'object' &&
                    contentRaw.title && contentRaw.href &&
                    !contentParams.rawUrl && !contentParams.hd));

            // Ảnh: chat.photo, photo, image, hoặc content có href+params.hd/rawUrl
            // Cho phép có title (caption) - title là chú thích ảnh, không phải tên file
            const isPhoto = !isFileMsg && !isCardMsg && !isVideoMsg && !isVoiceMsg && (
                rawMsgType === 'chat.photo' || rawMsgType === 'photo' || rawMsgType === 'image' ||
                (contentRaw && typeof contentRaw === 'object' &&
                    (contentParams.rawUrl || contentParams.hd ||
                     (contentRaw.href && !contentRaw.title)))
            );

            // ─── Download ảnh ─────────────────────────────────────────────
            if (!shouldSkipDownload && isPhoto && contentRaw && typeof contentRaw === 'object' && msgId) {
                const imgUrl = DatabaseService.extractImageUrlFromContent(contentRaw);
                if (imgUrl) {
                    const downloadPhoto = (attempt: number): void => {
                        FileStorageService.downloadImage(zaloId, imgUrl, undefined, mediaCookies, mediaUserAgent).then((localPath) => {
                            // CDN trả 401/403/409/410 → '' : không ghi local_paths rỗng (giao diện vẫn hiện ảnh CDN)
                            if (!localPath) return;
                            // File không hiển thị được (trang lỗi HTML, JPEG XL…) không được thành "ảnh trên máy": giao diện
                            // sẽ đổi sang file đó → lỗi → tự sửa lại.
                            const absPath = FileStorageService.resolveAbsolutePath(localPath);
                            const check = FileStorageService.validateImageFile(absPath);
                            if (!check.valid && check.reason !== 'truncated') {
                                try { fs.unlinkSync(absPath); } catch { /* đã mất */ }
                                Logger.warn(`[EventBroadcaster] Image for msg ${msgId} not displayable (${check.reason}) — keep CDN`);
                                return;
                            }
                            DatabaseService.getInstance().updateLocalPaths(zaloId, String(msgId), { main: localPath });
                            EventBroadcaster.send('event:localPath', { zaloId, msgId: String(msgId), threadId: message.threadId, localPaths: { main: localPath } });
                            Logger.log(`[EventBroadcaster] Downloaded image for msg ${msgId}: ${localPath}`);
                        }).catch((err) => {
                            Logger.warn(`[EventBroadcaster] Image download failed for ${msgId}: ${err.message}`);
                            // Mạng chập chờn / quá giờ (không phải CDN trả lỗi HTTP): thử lại 1 lần, trừ khi đã có file (tự sửa)
                            if (attempt > 0 || err?.response) return;
                            const retry = setTimeout(() => {
                                try {
                                    const row: any = DatabaseService.getInstance().getMessageById(zaloId, String(msgId), message.threadId || undefined);
                                    const lp = typeof row?.local_paths === 'string' ? JSON.parse(row.local_paths || '{}') : (row?.local_paths || {});
                                    if (!row || lp?.main) return;
                                } catch { return; }
                                downloadPhoto(1);
                            }, 20_000);
                            (retry as any).unref?.();
                        });
                    };
                    downloadPhoto(0);
                }
            }

            // Card message (chat.recommended): URLs (thumb, qrCodeUrl) are stable on Zalo CDN
            // No local download needed - use remote URLs directly in UI
            if (isCardMsg) {
                Logger.log(`[EventBroadcaster] Card message ${msgId}: using remote thumb/qrCode URLs directly`);
                // Save link to links table if this is a link card
                const cardAction = contentRaw?.action || '';
                if (cardAction === 'recommened.link') {
                    const titleRaw = String(contentRaw.title || '');
                    const hrefFromTitle = (titleRaw.match(/https?:\/\/\S+/i)?.[0] || '').trim();
                    const href = String(contentRaw.href || hrefFromTitle || '');
                    const params = (() => { try { const p = contentRaw.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
                    // Keep full title from sender (can be "url + newline + text"), fallback to preview title only when missing.
                    const title = String(titleRaw || params.mediaTitle || href);
                    const domain = String(params.src || '');
                    const thumbUrl = String(contentRaw.thumb || '');
                    if (href) {
                        const ts = parseInt(String(message.data?.ts)) || Date.now();
                        DatabaseService.getInstance().saveLink(zaloId, message.threadId, String(msgId), href, title, domain, thumbUrl, ts);
                        Logger.log(`[EventBroadcaster] Saved link for msg ${msgId}: ${href}`);
                    }
                }
            }

            // ─── Download file đính kèm ────────────────────────────────────
            if (!shouldSkipDownload && isFileMsg && contentRaw && typeof contentRaw === 'object' && msgId) {
                const fileHref = String(contentRaw.href || '');
                const fileTitle = String(contentRaw.title || '');
                if (fileHref && fileTitle) {
                    // Lấy extension từ params.fileExt hoặc từ tên file
                    const paramsData: any = (() => {
                        try {
                            const p = contentRaw.params;
                            return typeof p === 'string' ? JSON.parse(p) : (p || {});
                        } catch { return {}; }
                    })();
                    const extFromParams = paramsData.fileExt ? `.${paramsData.fileExt}` : '';
                    const extFromTitle = path.extname(fileTitle);
                    const finalExt = extFromParams || extFromTitle || '';
                    // Sanitize: remove illegal chars, then trailing dots/spaces (Windows rejects "file.")
                    const safeFilename = (fileTitle.includes('.') ? fileTitle : `${fileTitle}${finalExt}`)
                        .replace(/[/\\?%*:|"<>]/g, '_').replace(/[. ]+$/, '').trim() || `file_${Date.now()}${finalExt}`;
                    FileStorageService.downloadFile(zaloId, fileHref, safeFilename, mediaCookies, mediaUserAgent).then((localPath) => {
                        DatabaseService.getInstance().updateLocalPaths(zaloId, String(msgId), { file: localPath, fileName: safeFilename });
                        EventBroadcaster.send('event:localPath', { zaloId, msgId: String(msgId), threadId: message.threadId, localPaths: { file: localPath, fileName: safeFilename } });
                        Logger.log(`[EventBroadcaster] Downloaded file for msg ${msgId}: ${localPath}`);
                    }).catch((err) => Logger.warn(`[EventBroadcaster] File download failed for ${msgId}: ${err.message}`));
                }
            }

            // Download attachments array nếu có
            if (!shouldSkipDownload && message.data?.attachments?.length > 0) {
                FileStorageService.downloadAttachments(zaloId, message.data.attachments).catch(
                    (err) => Logger.warn(`[EventBroadcaster] Failed to download attachments: ${err.message}`)
                );
            }

            Logger.log(`[EventBroadcaster] broadcastMessage → event:message zaloId=${zaloId} msgId=${message.data?.msgId} isSelf=${message.isSelf} threadId=${message.threadId} fromRelay=${!!options?.fromRelay} activeIsDefault=${activeIsDefault}`);
            // fromRelay: skip onBeforeSend hooks to avoid infinite relay loop
            // (Boss relay → Employee broadcastMessage → send → hook → relay → loop)
            if (options?.fromRelay) {
                // Employee relay - NEVER called anymore (handled by saveRelayMessageToWorkspaceDb)
                this.sendDirect('event:message', { zaloId, message });
            } else if (!activeIsDefault) {
                // Boss webhook but employee workspace is active:
                // Fire hooks (to relay to employees) but DON'T send to renderer.
                // The employee's handlePushedEvent → sendDirect handles renderer display.
                this.fireHooksOnly('event:message', { zaloId, message });
            } else {
                // Boss webhook, default workspace is active: normal flow
                this.send('event:message', { zaloId, message });
            }
        } catch (error: any) {
            Logger.error(`[EventBroadcaster] broadcastMessage error: ${error.message}`);
        }
    }

    /**
     * Broadcast kết nối thành công
     */
    public static broadcastConnected(zaloId: string, accountInfo: any): void {
        Logger.log(`[EventBroadcaster] Broadcasting connected for ${zaloId}`);
        this.sendAware('event:connected', { zaloId, accountInfo });
    }

    /**
     * Hồ sơ của chính tài khoản vừa đổi (hiện có: cờ Zalo Business). Renderer cập nhật accountStore; relay cho nhân viên
     * được giao tài khoản (id trong zaloId).
     */
    public static broadcastAccountProfile(zaloId: string, profile: { is_business?: 0 | 1 }): void {
        this.sendAware('event:accountProfile', { zaloId, ...profile });
    }

    /**
     * Broadcast ngắt kết nối
     */
    public static broadcastDisconnected(zaloId: string, reason?: string): void {
        Logger.log(`[EventBroadcaster] Broadcasting disconnected for ${zaloId}`);
        this.sendAware('event:disconnected', { zaloId, reason: reason || 'Unknown' });
    }

    /**
     * Broadcast reaction
     * Persist to boss DB only when employee workspace is active (renderer won't handle it).
     * When boss workspace is active, the renderer receives event:reaction and saves via ipc.db.updateReaction.
     */
    public static broadcastReaction(zaloId: string, reaction: any): void {
        const { activeIsDefault } = this.resolveBossContext();

        // Only persist manually when renderer will NOT receive the event (employee WS active)
        if (!activeIsDefault) {
            try {
                const rData = reaction.data || {};
                const userId = String(rData.uidFrom || reaction.uidFrom || '');
                const rMsg: any[] = rData.content?.rMsg || reaction.content?.rMsg || [];
                const targetMsgId = rMsg.length > 0
                    ? String(rMsg[0].gMsgID || rMsg[0].cMsgID || '')
                    : String(rData.msgId || reaction.msgId || '');
                const rawIcon: string = rData.content?.rIcon || reaction.content?.rIcon || reaction.rIcon || rData.rIcon || '';
                const emoji = zaloReactionIconToEmoji(rawIcon);
                const threadId = String(reaction.threadId || rData.idTo || rData.threadId || '');
                if (userId && targetMsgId) {
                    this.runOnBossDb((db) => {
                        db.updateMessageReaction(zaloId, targetMsgId, userId, emoji, threadId || undefined);
                    });
                }
            } catch (err: any) {
                Logger.warn(`[EventBroadcaster] broadcastReaction DB persist error: ${err.message}`);
            }
        }

        this.sendAware('event:reaction', { zaloId, reaction });
    }

    /**
     * Broadcast lời mời kết bạn (incoming) + tự động lưu vào DB.
     * Called from ZaloLoginHelper ONLY for FriendEventType.REQUEST (type=2).
     * The caller is responsible for resolving user info (getUserInfo) first.
     *
     * @param zaloId
     * @param requester Normalized object: { userId, displayName, avatar, phoneNumber, msg }
     */
    public static broadcastFriendRequest(
        zaloId: string,
        requester: { userId: string; displayName: string; avatar: string; phoneNumber?: string; msg: string }
    ): void {
        const { userId, displayName, avatar, phoneNumber, msg } = requester;
        if (!userId) {
            Logger.warn(`[EventBroadcaster] broadcastFriendRequest: no userId`);
            return;
        }

        try {
            this.runOnBossDb((db) => db.upsertFriendRequest(
                zaloId,
                { userId, displayName: displayName || '', avatar: avatar || '', phone: phoneNumber || '', msg: msg || '', createdAt: Date.now() },
                'received'
            ));
            Logger.log(`[EventBroadcaster] Auto-saved friend request from ${userId} (${displayName}) msg="${msg}" for ${zaloId}`);
        } catch (err: any) {
            Logger.warn(`[EventBroadcaster] broadcastFriendRequest DB save error: ${err.message}`);
        }
        this.sendAware('event:friendRequest', { zaloId, requester });
    }

    /**
     * Broadcast khi mình gửi lời mời kết bạn thành công.
     * Cache vào friend_requests(direction='sent') + broadcast realtime cho UI.
     */
    public static broadcastFriendRequestSent(
        zaloId: string,
        requester: { userId: string; displayName: string; avatar: string; phoneNumber?: string; msg?: string }
    ): void {
        const { userId, displayName, avatar, phoneNumber, msg } = requester;
        if (!userId) {
            Logger.warn(`[EventBroadcaster] broadcastFriendRequestSent: no userId`);
            return;
        }

        try {
            this.runOnBossDb((db) => db.upsertFriendRequest(
                zaloId,
                {
                    userId,
                    displayName: displayName || '',
                    avatar: avatar || '',
                    phone: phoneNumber || '',
                    msg: msg || '',
                    createdAt: Date.now(),
                },
                'sent'
            ));
            Logger.log(`[EventBroadcaster] Auto-saved sent friend request to ${userId} (${displayName}) for ${zaloId}`);
        } catch (err: any) {
            Logger.warn(`[EventBroadcaster] broadcastFriendRequestSent DB save error: ${err.message}`);
        }

        this.sendAware('event:friendRequestSent', { zaloId, requester });
    }

    /**
     * Broadcast khi lời mời kết bạn bị xoá khỏi cache local.
     * Dùng cho REJECT_REQUEST / huỷ lời mời / đối phương thu hồi lời mời.
     */
    public static broadcastFriendRequestRemoved(
        zaloId: string,
        payload: { userId: string; direction?: 'received' | 'sent' | 'all'; reason?: string }
    ): void {
        const userId = String(payload.userId || '');
        const direction = payload.direction || 'sent';
        if (!userId) {
            Logger.warn(`[EventBroadcaster] broadcastFriendRequestRemoved: no userId`);
            return;
        }

        try {
            this.runOnBossDb((db) => {
                if (direction === 'all') {
                    db.removeFriendRequest(zaloId, userId, 'received');
                    db.removeFriendRequest(zaloId, userId, 'sent');
                } else {
                    db.removeFriendRequest(zaloId, userId, direction);
                }
            });
            Logger.log(`[EventBroadcaster] Removed ${direction} friend request for ${userId} on ${zaloId} (reason=${payload.reason || 'unknown'})`);
        } catch (err: any) {
            Logger.warn(`[EventBroadcaster] broadcastFriendRequestRemoved error: ${err.message}`);
        }

        this.sendAware('event:friendRequestRemoved', {
            zaloId,
            userId,
            direction,
            reason: payload.reason || '',
        });
    }

    /**
     * Broadcast khi trở thành bạn bè.
     * Add vào friends DB + broadcast event:friendAccepted.
     */
    public static broadcastFriendAccepted(
        zaloId: string,
        friend: { userId: string; displayName: string; avatar: string; phoneNumber?: string }
    ): void {
        const { userId, displayName, avatar, phoneNumber } = friend;
        if (!userId) return;
        try {
            this.runOnBossDb((db) => db.addFriend(zaloId, { userId, displayName: displayName || '', avatar: avatar || '', phone: phoneNumber || '' }));
            Logger.log(`[EventBroadcaster] Friend accepted: ${userId} (${displayName}) added to friends for ${zaloId}`);
        } catch (err: any) {
            Logger.warn(`[EventBroadcaster] broadcastFriendAccepted addFriend error: ${err.message}`);
        }
        try {
            this.runOnBossDb((db) => {
                db.removeFriendRequest(zaloId, userId, 'sent');
                db.removeFriendRequest(zaloId, userId, 'received');
            });
        } catch {}
        this.sendAware('event:friendAccepted', { zaloId, userId, requester: friend });
    }

    /**
     * Broadcast khi bạn bè bị xóa (FriendEventType.REMOVE = 1).
     * Remove from friends DB + event:friendRemoved (trước đây chỉ xoá DB: UI Boss / nhân viên vẫn hiện "bạn bè"
     * tới khi tải lại).
     */
    public static broadcastFriendRemoved(zaloId: string, friendId: string): void {
        if (!friendId) return;
        try {
            this.runOnBossDb((db) => db.removeFriend(zaloId, friendId));
            Logger.log(`[EventBroadcaster] Friend removed: ${friendId} for ${zaloId}`);
        } catch (err: any) {
            Logger.warn(`[EventBroadcaster] broadcastFriendRemoved error: ${err.message}`);
        }
        this.sendAware('event:friendRemoved', { zaloId, userId: String(friendId) });
    }

    /**
     * Broadcast group info update (name, avatar, members)
     */
    public static broadcastGroupInfoUpdate(zaloId: string, groupId: string, name: string, avatar: string, data?: any): void {
        this.sendAware('event:groupInfoUpdate', { zaloId, groupId, name, avatar, data });
    }

    /**
     * Broadcast group event - also saves a system message to DB
     */
    public static broadcastGroupEvent(zaloId: string, groupId: string, eventType: string, rawEvent: any): void {
        // ── Handle remind_topic event (reminder notification) ─────────────────────
        if (eventType === 'remind_topic') {
            try {
                const d = rawEvent?.data || rawEvent || {};
                const emoji = d.emoji || '⏰';
                const msg = d.msg || '';
                const color = d.color !== undefined && d.color !== 'null' ? Number(d.color) : -1;
                const content = {
                    title: msg ? JSON.parse(msg) : 'Nhắc hẹn',
                    description: '',
                    params: JSON.stringify({
                        actions: [{
                            actionId: 'action.open.reminder',
                            data: JSON.stringify({
                                act: 'remind_reminder11',
                                data: JSON.stringify({ emoji, color, params: { title: msg ? JSON.parse(msg) : 'Nhắc hẹn' } })
                            })
                        }]
                    })
                };
                Logger.log(`[EventBroadcaster] ⏰ Reminder notification from group_event: thread=${groupId} emoji="${emoji}" msg="${msg}"`);
                this.broadcastReminderNotification(zaloId, groupId, 'chat.ecard', content);
            } catch (err: any) {
                Logger.warn(`[EventBroadcaster] remind_topic broadcast error: ${err.message}`);
            }
        }

        // Nhóm ẩn danh sách thành viên: updateMembers rỗng → người thực hiện (sourceId). Tên tra trong DB; chưa có thì
        // getUserInfo (gộp lô) rồi sửa dòng thông báo — trước đây luôn là "Thành viên đã rời khỏi nhóm".
        const actorId = groupId ? groupEventActorId(eventType, rawEvent) : '';
        const actor = actorId ? EventBroadcaster.lookupKnownMember(zaloId, groupId, actorId) : null;
        const systemText = actorId
            ? groupEventActorText(eventType, actor?.name || '', rawEvent)
            : EventBroadcaster.generateGroupEventText(eventType, rawEvent, zaloId, groupId);
        const systemMembers = actorId && actor?.name ? [{ id: actorId, dName: actor.name, avatar: actor.avatar }] : undefined;
        const msgId = `sys_${eventType}_${groupId}_${Date.now()}`;
        const timestamp = Date.now();

        if (eventType === 'new_pin_topic' || eventType === 'update_pin_topic') {
            try {
                const d = rawEvent?.data || rawEvent || {};
                const topic = d.topic;
                if (topic && groupId) {
                    let noteTitle = '';
                    try { noteTitle = JSON.parse(topic.params || '{}').title || ''; } catch {}
                    const topicId = String(topic.id || '');
                    const creatorId = String(d.actorId || topic.creatorId || '');
                    const createTime = Number(topic.createTime || Date.now());
                    if (topicId && noteTitle) {
                        try {
                            this.runOnBossDb((db) => db.pinMessage(zaloId, groupId, {
                                msgId: `note_${topicId}`, msgType: 'note',
                                content: JSON.stringify({ topicId, title: noteTitle, creatorId, createTime }),
                                previewText: noteTitle, previewImage: '', senderId: creatorId, senderName: '', timestamp: createTime,
                            }));
                        } catch (dbErr: any) { Logger.warn(`[EventBroadcaster] save note pin to DB error: ${dbErr.message}`); }
                    }
                    this.sendAware('event:groupEvent', {
                        zaloId, groupId, eventType: 'new_pin_topic',
                        notePin: { topicId, title: noteTitle || topicId, creatorId, createTime, editTime: Number(topic.editTime || Date.now()) },
                        data: rawEvent, systemText: '', msgId, timestamp,
                    });
                    Logger.log(`[EventBroadcaster] Pinned topic ${topic.id} ("${noteTitle}") in group ${groupId}`);
                }
            } catch (err: any) { Logger.warn(`[EventBroadcaster] pin_topic broadcast error: ${err.message}`); }
        } else if (eventType === 'unpin_topic') {
            try {
                const d = rawEvent?.data || rawEvent || {};
                const topic = d.topic;
                if (topic && groupId) {
                    const topicId = String(topic.id || topic.topicId || '');
                    if (topicId) {
                        try { this.runOnBossDb((db) => db.unpinMessage(zaloId, groupId, `note_${topicId}`)); } catch {}
                        this.sendAware('event:groupEvent', {
                            zaloId, groupId, eventType: 'unpin_topic', notePin: { topicId },
                            data: rawEvent, systemText: '', msgId, timestamp,
                        });
                        Logger.log(`[EventBroadcaster] Unpinned topic ${topicId} in group ${groupId}`);
                    }
                }
            } catch (err: any) { Logger.warn(`[EventBroadcaster] unpin_topic broadcast error: ${err.message}`); }
        }

        if (eventType === 'update_board' || eventType === 'update_topic') {
            try {
                const d = rawEvent?.data || rawEvent || {};
                const topic = d.groupTopic || d.topic;
                if (topic && groupId) {
                    let noteTitle = '';
                    try { noteTitle = JSON.parse(topic.params || '{}').title || ''; } catch {}
                    const topicId = String(topic.id || '');
                    const action = topic.action;
                    if (topicId) {
                        if (action === 1) {
                            const creatorId = String(d.sourceId || topic.creatorId || '');
                            const createTime = Number(topic.createTime || Date.now());
                            if (noteTitle) {
                                try {
                                    this.runOnBossDb((db) => db.pinMessage(zaloId, groupId, {
                                        msgId: `note_${topicId}`, msgType: 'note',
                                        content: JSON.stringify({ topicId, title: noteTitle, creatorId, createTime }),
                                        previewText: noteTitle, previewImage: '', senderId: creatorId, senderName: '', timestamp: createTime,
                                    }));
                                } catch {}
                            }
                            this.sendAware('event:groupEvent', {
                                zaloId, groupId, eventType: 'new_pin_topic',
                                notePin: { topicId, title: noteTitle || topicId, creatorId, createTime, editTime: Number(topic.editTime || Date.now()) },
                                data: rawEvent, systemText: '', msgId, timestamp,
                            });
                        } else if (action === 0) {
                            try { this.runOnBossDb((db) => db.unpinMessage(zaloId, groupId, `note_${topicId}`)); } catch {}
                            this.sendAware('event:groupEvent', {
                                zaloId, groupId, eventType: 'unpin_topic', notePin: { topicId },
                                data: rawEvent, systemText: '', msgId, timestamp,
                            });
                        }
                    }
                }
            } catch (err: any) { Logger.warn(`[EventBroadcaster] update_board topic error: ${err.message}`); }
        }

        if (systemText && groupId) {
            try {
                const d2 = rawEvent?.data || rawEvent || {};
                const um: any[] = d2.updateMembers || [];
                this.runOnBossDb((db) => db.saveSystemMessage(zaloId, groupId, msgId, systemText, timestamp, um.length > 0 ? um : systemMembers));
            } catch {}
        }

        const d = rawEvent?.data || rawEvent || {};
        const updateMembers: any[] = d.updateMembers || [];
        if (updateMembers.length > 0 && groupId) {
            const creatorId: string = d.creatorId || '';
            try {
                this.runOnBossDb((db) => {
                    for (const um of updateMembers) {
                        const uid: string = um.id || '';
                        if (!uid) continue;
                        switch (eventType) {
                            case 'join':
                                db.upsertGroupMember(zaloId, groupId, { memberId: uid, displayName: um.dName || um.zaloName || '', avatar: um.avatar || um.avatar_25 || '', role: 0 });
                                break;
                            case 'leave': case 'remove_member': case 'block_member':
                                db.removeGroupMember(zaloId, groupId, uid);
                                break;
                            // Quy ước Zalo trong DB: phó nhóm = 1, trưởng nhóm = 2 (shared/chat/groupMemberRoles) — trước đây
                            // ghi phó nhóm mới thành 2 → hiện "Trưởng nhóm"
                            case 'add_admin':
                                db.upsertGroupMember(zaloId, groupId, { memberId: uid, displayName: um.dName || um.zaloName || '', avatar: um.avatar || um.avatar_25 || '', role: groupAdminRole('zalo') });
                                break;
                            case 'remove_admin':
                                db.upsertGroupMember(zaloId, groupId, { memberId: uid, displayName: um.dName || um.zaloName || '', avatar: um.avatar || um.avatar_25 || '', role: uid === creatorId ? groupOwnerRole('zalo') : 0 });
                                break;
                        }
                    }
                });
            } catch (err: any) { Logger.warn(`[EventBroadcaster] Surgical member DB update failed: ${err.message}`); }
        }

        this.sendAware('event:groupEvent', { zaloId, groupId, eventType, data: rawEvent, systemText, systemMembers, msgId, timestamp });
        if (actorId && !actor?.name && systemText) {
            EventBroadcaster.scheduleActorResolution({ zaloId, groupId, eventType, rawEvent, msgId, timestamp, actorId, placeholder: systemText });
        }

        const CACHE_INVALIDATING_EVENTS = new Set([
            'join', 'leave', 'remove_member', 'block_member',
            'add_admin', 'remove_admin', 'update_setting', 'update', 'update_avatar',
        ]);
        if (groupId && CACHE_INVALIDATING_EVENTS.has(eventType) && _invalidateGroupCacheFn) {
            _invalidateGroupCacheFn(zaloId, groupId);
        }
    }

    // ─── Nhóm ẩn thành viên: tên người thực hiện sự kiện ─────────────────────

    /** Tên / avatar đã biết của một người (bản thân, liên hệ, thành viên nhóm đã lưu) — không gọi mạng. */
    private static lookupKnownMember(zaloId: string, groupId: string, uid: string): { name: string; avatar: string } | null {
        if (uid === zaloId) return { name: 'Bạn', avatar: '' };
        try {
            return this.withBossDb((db) => {
                const contact: any = db.getContactById(zaloId, uid);
                const contactName = String(contact?.alias || contact?.display_name || '').trim();
                if (contactName && contactName !== uid) return { name: contactName, avatar: String(contact?.avatar_url || '') };
                const member = db.queryOne<{ display_name: string; avatar: string }>(
                    `SELECT display_name, avatar FROM page_group_member
                     WHERE owner_zalo_id = ? AND member_id = ? AND display_name != ''
                     ORDER BY (group_id = ?) DESC, updated_at DESC LIMIT 1`,
                    [zaloId, uid, groupId],
                );
                return member?.display_name ? { name: String(member.display_name), avatar: String(member.avatar || '') } : null;
            });
        } catch {
            return null;
        }
    }

    private static readonly ACTOR_PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
    private static actorProfileCache = new Map<string, { name: string; avatar: string; at: number }>();
    private static actorLookupQueue = new Map<string, { jobs: GroupActorJob[] }>();

    /** Gom các sự kiện trong ~1,5 s thành một lệnh getUserInfo (≤ 50 UID) cho mỗi tài khoản. */
    private static scheduleActorResolution(job: GroupActorJob): void {
        const cached = this.actorProfileCache.get(`${job.zaloId}:${job.actorId}`);
        if (cached && Date.now() - cached.at < this.ACTOR_PROFILE_TTL_MS) {
            this.applyResolvedActor(job, cached);
            return;
        }
        let queue = this.actorLookupQueue.get(job.zaloId);
        if (!queue) {
            queue = { jobs: [] };
            this.actorLookupQueue.set(job.zaloId, queue);
            setTimeout(() => { void this.flushActorResolution(job.zaloId); }, 1500);
        }
        queue.jobs.push(job);
    }

    private static async flushActorResolution(zaloId: string): Promise<void> {
        const queue = this.actorLookupQueue.get(zaloId);
        this.actorLookupQueue.delete(zaloId);
        if (!queue?.jobs.length) return;
        const api: any = require('../../utils/connection/ConnectionManager').default.getAllConnections().get(zaloId)?.api;
        if (!api?.getUserInfo) return;
        const uids = [...new Set(queue.jobs.map((job) => job.actorId))];
        for (let i = 0; i < uids.length; i += 50) {
            const chunk = uids.slice(i, i + 50);
            try {
                const response = await api.getUserInfo(chunk);
                for (const uid of chunk) {
                    const profile = profileFromUserInfo(response, uid);
                    if (profile?.name) this.actorProfileCache.set(`${zaloId}:${uid}`, { ...profile, at: Date.now() });
                }
            } catch (err: any) {
                Logger.warn(`[EventBroadcaster] getUserInfo cho sự kiện nhóm lỗi: ${err?.message || err}`);
            }
        }
        if (this.actorProfileCache.size > 2000) this.actorProfileCache.clear();
        for (const job of queue.jobs) {
            const profile = this.actorProfileCache.get(`${zaloId}:${job.actorId}`);
            if (profile?.name) this.applyResolvedActor(job, profile);
        }
    }

    /** Sửa dòng thông báo đã lưu / đang hiện (chỉ khi vẫn là chữ tạm) và báo renderer + nhân viên. */
    private static applyResolvedActor(job: GroupActorJob, profile: { name: string; avatar: string }): void {
        const text = groupEventActorText(job.eventType, profile.name, job.rawEvent);
        if (!text || text === job.placeholder) return;
        const members = [{ id: job.actorId, dName: profile.name, avatar: profile.avatar }];
        try {
            this.runOnBossDb((db) => {
                db.run(
                    // CAST: không để SQLite quét cả nhóm theo index thread (xem SAME_THREAD_SQL ở DatabaseService)
                    `UPDATE messages SET content = ?, attachments = ?
                     WHERE owner_zalo_id = ? AND CAST(thread_id AS TEXT) = ? AND msg_id = ? AND content = ?`,
                    [text, JSON.stringify(members), job.zaloId, job.groupId, job.msgId, job.placeholder],
                );
                db.run(
                    `UPDATE contacts SET last_message = ?
                     WHERE owner_zalo_id = ? AND contact_id = ? AND last_message IN (?, ?)`,
                    [`🔔 ${text}`, job.zaloId, job.groupId, job.placeholder, `🔔 ${job.placeholder}`],
                );
            });
        } catch (err: any) {
            Logger.warn(`[EventBroadcaster] cập nhật thông báo nhóm lỗi: ${err?.message || err}`);
        }
        this.sendAware('event:groupEvent', {
            zaloId: job.zaloId, groupId: job.groupId, eventType: job.eventType, data: job.rawEvent,
            systemText: text, systemMembers: members, msgId: job.msgId, timestamp: job.timestamp,
            update: true, previousText: job.placeholder,
        });
    }

    /**
     * Settings that produce a visible system message in Zalo's chat.
     * Value [0] = text when turned off, [1] = text when turned on.
     */
    private static readonly VISIBLE_SETTINGS: Record<string, [string, string]> = {
        joinAppr:       ['Hình thức tham gia nhóm: Không cần phê duyệt', 'Hình thức tham gia nhóm: Cần phê duyệt'],
        lockSendMsg:    ['Đã mở khóa gửi tin nhắn cho thành viên',       'Đã khóa gửi tin nhắn cho thành viên'],
        blockName:      ['Cho phép thành viên đổi tên nhóm',              'Đã khóa đổi tên nhóm'],
        addMemberOnly:  ['Thành viên có thể thêm người vào nhóm',         'Chỉ trưởng/phó nhóm mới được thêm thành viên'],
        setTopicOnly:   ['Thành viên có thể đặt chủ đề nhóm',             'Chỉ trưởng/phó nhóm mới được đặt chủ đề'],
        lockCreatePost: ['Thành viên có thể đăng bài',                    'Chỉ trưởng/phó nhóm mới được đăng bài'],
        lockCreatePoll: ['Thành viên có thể tạo bình chọn',               'Chỉ trưởng/phó nhóm mới được tạo bình chọn'],
        lockViewMember: ['Thành viên có thể xem danh sách thành viên',    'Đã ẩn danh sách thành viên'],
    };

    /**
     * featureId values from extraData that map to INVISIBLE settings
     * (Zalo does NOT show a chat message for these setting changes).
     */
    private static readonly INVISIBLE_FEATURE_IDS = new Set<number>([
        25, // enableMsgHistory
    ]);

    /** Maps known featureId values to a groupSetting key */
    private static readonly FEATURE_ID_TO_KEY: Record<number, string> = {
        25: 'enableMsgHistory',
    };

    private static generateGroupEventText(eventType: string, rawEvent: any, zaloId?: string, groupId?: string): string {
        // data is inside rawEvent.data for most event types
        const d = rawEvent?.data || rawEvent || {};
        const updateMembers: any[] = d.updateMembers || [];
        const memberNames = updateMembers.map((m: any) => m.dName || m.zaloName || m.id || '').filter(Boolean).join(', ');
        const actor = memberNames || 'Thành viên';

        switch (eventType) {
            case 'join':
                return `${actor} đã tham gia nhóm`;
            case 'leave':
                return `${actor} đã rời khỏi nhóm`;
            case 'remove_member':
                return `${actor} đã bị xóa khỏi nhóm`;
            case 'block_member':
                return `${actor} đã bị cấm khỏi nhóm`;
            case 'update_setting': {
                const newSettings: Record<string, number> = d.groupSetting || {};
                const extraData = d.extraData || {};
                const featureId: number | undefined = extraData.featureId !== undefined
                    ? Number(extraData.featureId) : undefined;
                const cacheKey = `${zaloId || ''}_${groupId || d.groupId || ''}`;
                const prevSettings = EventBroadcaster.previousGroupSettings.get(cacheKey);

                // Always update cache so next event can diff against current state
                if (Object.keys(newSettings).length > 0) {
                    EventBroadcaster.previousGroupSettings.set(cacheKey, { ...newSettings });
                }

                // ── Invisible featureIds: Zalo does NOT show a chat message ────────────
                if (featureId !== undefined && EventBroadcaster.INVISIBLE_FEATURE_IDS.has(featureId)) {
                    return '';
                }

                // ── Known featureId → visible setting ─────────────────────────────────
                if (featureId !== undefined) {
                    const key = EventBroadcaster.FEATURE_ID_TO_KEY[featureId];
                    if (key) {
                        const labels = EventBroadcaster.VISIBLE_SETTINGS[key];
                        const val = newSettings[key];
                        if (labels && val !== undefined) {
                            return labels[val as 0 | 1] || '';
                        }
                    }
                    // Unknown featureId - fall through to diff approach below
                    // (do NOT silently return '' – we may still have prev state to diff against)
                }

                // ── No featureId: diff against previous cached settings ─────────────
                if (prevSettings && Object.keys(newSettings).length > 0) {
                    const messages: string[] = [];
                    for (const [key, labels] of Object.entries(EventBroadcaster.VISIBLE_SETTINGS)) {
                        const newVal = newSettings[key];
                        const prevVal = prevSettings[key];
                        if (newVal !== undefined && prevVal !== undefined && newVal !== prevVal) {
                            messages.push(labels[newVal as 0 | 1] || '');
                        }
                    }
                    const filtered = messages.filter(Boolean);
                    if (filtered.length > 0) return filtered.join('\n');
                }

                // No previous state or no visible changes detected → silent
                return '';
            }
            case 'new_link': {
                const link: string = d.link || d.inviteLink || d.groupLink || d.linkJoin
                    || d.info?.group_link || '';
                if (link) return `Link mới tham gia nhóm: ${link}`;
                return 'Link nhóm mới đã được tạo';
            }
            case 'update':
            case 'update_avatar': {
                const subType: number = d.subType || 0;
                const groupName: string = d.groupName || '';
                if (subType === 1 && groupName) return `Tên nhóm đã được đổi thành "${groupName}"`;
                if (subType === 2 || d.avt || d.fullAvt) return 'Ảnh nhóm đã được thay đổi';
                if (groupName) return `Tên nhóm đã được đổi thành "${groupName}"`;
                return 'Nhóm đã được cập nhật';
            }
            case 'add_admin':
                return `${actor} đã được thêm làm phó nhóm`;
            case 'remove_admin':
                return `${actor} đã bị xóa khỏi vai trò phó nhóm`;
            case 'join_request': {
                const uids: string[] = d.uids || [];
                const total: number = d.totalPending || uids.length || 1;
                return `${total} người đang chờ phê duyệt vào nhóm`;
            }
            case 'remind_topic': {
                const emoji = d.emoji || '⏰';
                const msg = d.msg || '';
                let title = '';
                try {
                    title = msg ? JSON.parse(msg) : '';
                } catch {
                    title = msg;
                }
                return title ? `${emoji} ${title}` : `${emoji} Nhắc hẹn`;
            }
            default:
                return '';
        }
    }

    /** Tin Zalo đã hết hạn tự xoá (FR-ZL05.6): Zalo dọn tin trên thiết bị Zalo, Deplao giữ nguyên nội dung. */
    private static ttlExpiredIds(zaloId: string, msgIds: string[], threadId?: string): Set<string> {
        try {
            return this.withBossDb((db) => db.zaloTtlExpiredMessageIds(zaloId, msgIds, threadId));
        } catch {
            return new Set();
        }
    }

    /**
     * Broadcast undo message - marks as recalled in DB (keeps the row, changes status/type)
     */
    public static broadcastUndo(zaloId: string, msgId: string, threadId?: string): void {
        if (msgId && this.ttlExpiredIds(zaloId, [String(msgId)], threadId).size > 0) {
            Logger.log(`[EventBroadcaster] broadcastUndo: msgId=${msgId} đã hết hạn tự xoá trên Zalo — giữ nguyên nội dung`);
            return;
        }
        if (msgId) {
            this.runOnBossDb((db) => {
                db.markMessageRecalled(zaloId, String(msgId), threadId);
                if (threadId) { try { db.updateLastMessageIfRecalled(zaloId, threadId, String(msgId)); } catch {} }
            });
            Logger.log(`[EventBroadcaster] broadcastUndo: recalled msgId=${msgId} zaloId=${zaloId} threadId=${threadId}`);
        }
        this.sendAware('event:undo', { zaloId, msgId, threadId });
    }

    /**
     * Broadcast delete messages (chat.delete event) - marks as recalled in DB and notifies renderer.
     * Không xoá khỏi DB để giữ lịch sử - chỉ đánh dấu recalled.
     */
    public static broadcastDeleteMessages(zaloId: string, msgIds: string[], threadId: string): void {
        const expired = msgIds.length > 0 ? this.ttlExpiredIds(zaloId, msgIds.map(String), threadId) : new Set<string>();
        if (expired.size > 0) {
            Logger.log(`[EventBroadcaster] broadcastDeleteMessages: ${expired.size} tin hết hạn tự xoá trên Zalo — giữ nguyên nội dung`);
            msgIds = msgIds.filter((id) => !expired.has(String(id)));
            if (msgIds.length === 0) return;
        }
        if (msgIds.length > 0) {
            this.runOnBossDb((db) => {
                for (const msgId of msgIds) {
                    db.markMessageRecalled(zaloId, String(msgId), threadId);
                    try { db.updateLastMessageIfRecalled(zaloId, threadId, String(msgId)); } catch {}
                }
            });
            Logger.log(`[EventBroadcaster] broadcastDeleteMessages: marked ${msgIds.length} msgs as recalled in thread=${threadId}`);
        }
        this.sendAware('event:delete', { zaloId, msgIds, threadId });
    }

    /**
     * Broadcast reminder notification (chat.ecard event) - show full-screen notification
     */
    public static broadcastReminderNotification(zaloId: string, threadId: string, msgType: string, content: any): void {
        Logger.log(`[EventBroadcaster] broadcastReminderNotification: zaloId=${zaloId} threadId=${threadId}`);
        this.send('event:reminder', { zaloId, threadId, msgType, content });
    }

    /**
     * Broadcast typing event
     */
    public static broadcastTyping(zaloId: string, data: any): void {
        // zca-js Typing model:
        //   UserTyping:  { type: ThreadType.User,  threadId, isSelf, data: { uid, ts, isPC } }
        //   GroupTyping: { type: ThreadType.Group, threadId, isSelf, data: { uid, gid, ts, isPC } }
        try {
            const isGroup = data?.type === 1 || !!(data?.data?.gid);
            const threadId = data?.threadId
                || data?.data?.gid          // GroupTyping
                || data?.data?.idTo         // fallback
                || data?.data?.uidFrom
                || '';
            const userId = data?.data?.uid || data?.data?.uidFrom || data?.uidFrom || '';
            Logger.log(`[EventBroadcaster] typing: zaloId=${zaloId} threadId=${threadId} userId=${userId} isGroup=${isGroup}`);
            if (threadId && userId) this.send('event:typing', { zaloId, threadId, userId, isGroup });
        } catch {}
    }

    /**
     * Broadcast seen/read event
     * Phân biệt 2 model theo docs:
     *   UserSeenMessage  (type=0): data = { idTo, msgId, realMsgId }  → 1 người seen = người dùng kia
     *   GroupSeenMessage (type=1): data = { msgId, groupId, seenUids[] } → nhiều người seen trong nhóm
     */
    public static broadcastSeen(zaloId: string, data: any): void {
        try {
            const isGroup = data?.type === 1 || data?.data?.groupId;
            if (isGroup) {
                // GroupSeenMessage
                const threadId = data?.threadId || data?.data?.groupId || '';
                const msgId    = data?.data?.msgId || data?.msgId || '';
                const seenUids: string[] = data?.data?.seenUids || [];
                if (threadId) {
                    this.send('event:seen', { zaloId, threadId, msgId, isGroup: true, seenUids });
                }
            } else {
                // UserSeenMessage
                const threadId = data?.threadId || data?.data?.idTo || data?.data?.uidFrom || '';
                const msgId    = data?.data?.msgId || data?.data?.realMsgId || data?.msgId || '';
                // userId = người đối diện đã seen (không phải mình)
                const userId   = data?.data?.uidFrom || data?.uidFrom || threadId;
                if (threadId) {
                    this.send('event:seen', { zaloId, threadId, msgId, isGroup: false, seenUids: [userId] });
                }
            }
        } catch (e: any) {
            Logger.warn(`[EventBroadcaster] broadcastSeen error: ${e.message}`);
        }
    }

    /**
     * Zalo: hội thoại đã đọc ở máy khác (điện thoại / Zalo PC, cmd 504 / 524, services/zalo/zaloReadElsewhere) → số chưa
     * đọc trong DB Boss + renderer (db:unreadChanged; 0 = renderer xoá ngay). Không gửi "đã xem" ngược lên Zalo.
     */
    public static broadcastZaloReadElsewhere(zaloId: string, items: ZaloClearUnread[]): void {
        for (const item of items) {
            try {
                const result = this.withBossDb((db) => applyZaloClearUnread(db, zaloId, item));
                if (result.unread !== undefined) {
                    this.sendAware('db:unreadChanged', {
                        zaloId, contactId: item.threadId, unread: result.unread, source: 'zalo_read_elsewhere',
                    });
                }
                if (result.mentionCleared) {
                    this.sendAware('db:contactFlagsChanged', {
                        ownerZaloId: zaloId, contactId: item.threadId, flags: { has_mention: 0 },
                    });
                }
            } catch (e: any) {
                Logger.warn(`[EventBroadcaster] broadcastZaloReadElsewhere error: ${e.message}`);
            }
        }
    }

    /**
     * Broadcast QR code update
     */
    public static broadcastQRUpdate(tempId: string, qrDataUrl: string, status: string): void {
        this.send('qr:update', { tempId, qrDataUrl, status });
    }

    /**
     * Broadcast listener dead (max retries exhausted or fatal token error)
     * → renderer hiển thị cảnh báo và nút reconnect thủ công
     */
    public static broadcastListenerDead(zaloId: string, reason: string): void {
        Logger.warn(`[EventBroadcaster] broadcastListenerDead: ${zaloId} reason=${reason}`);
        this.send('event:listenerDead', { zaloId, reason });
    }
}

export default EventBroadcaster;

