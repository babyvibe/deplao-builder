"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGroupCacheInvalidator = registerGroupCacheInvalidator;
const path = __importStar(require("path"));
const Logger_1 = __importDefault(require("../utils/Logger"));
const DatabaseService_1 = __importDefault(require("./DatabaseService"));
const FileStorageService_1 = __importDefault(require("./FileStorageService"));
/** Callback để invalidate group cache trong ZaloLoginHelper (tránh circular import) */
let _invalidateGroupCacheFn = null;
function registerGroupCacheInvalidator(fn) {
    _invalidateGroupCacheFn = fn;
}
/**
 * EventBroadcaster - Thay thế ApiService webhook bằng Electron IPC events
 * Broadcast Zalo events từ main process → renderer process
 */
class EventBroadcaster {
    /**
     * Pre-seed the settings cache for a group so the FIRST update_setting event
     * can diff against a known baseline.  Call this BEFORE invoking updateGroupSettings.
     */
    static seedGroupSettings(zaloId, groupId, settings) {
        const cacheKey = `${zaloId}_${groupId}`;
        // Only seed if there is no existing entry – don't overwrite a fresher cache
        if (!this.previousGroupSettings.has(cacheKey) && Object.keys(settings).length > 0) {
            // Cap cache size to prevent unbounded memory growth
            if (this.previousGroupSettings.size > 1000) {
                const firstKey = this.previousGroupSettings.keys().next().value;
                if (firstKey)
                    this.previousGroupSettings.delete(firstKey);
            }
            this.previousGroupSettings.set(cacheKey, { ...settings });
        }
    }
    static setWindow(win) {
        this.window = win;
    }
    /** Generic channel emit — dùng bởi CRMQueueService và các service khác */
    static emit(channel, data) {
        this.send(channel, data);
    }
    // ─── Workspace-aware helpers ──────────────────────────────────────
    static resolveBossContext() {
        try {
            const WorkspaceManager = require('../utils/WorkspaceManager').default;
            const wm = WorkspaceManager.getInstance();
            const activeIsDefault = wm.getActiveWorkspaceId() === 'default';
            if (!activeIsDefault) {
                const defaultWs = wm.getWorkspaceById('default');
                if (defaultWs) {
                    return { bossDbPath: wm.resolveDbPath(defaultWs.dbPath || 'deplao-tool.db'), activeIsDefault: false };
                }
            }
            return { bossDbPath: null, activeIsDefault: true };
        }
        catch {
            return { bossDbPath: null, activeIsDefault: true };
        }
    }
    static runOnBossDb(fn) {
        const { bossDbPath } = this.resolveBossContext();
        const db = DatabaseService_1.default.getInstance();
        if (bossDbPath) {
            db.withDbPath(bossDbPath, () => fn(db));
        }
        else {
            fn(db);
        }
    }
    static sendAware(channel, data) {
        const { activeIsDefault } = this.resolveBossContext();
        if (activeIsDefault) {
            this.send(channel, data);
        }
        else {
            this.fireHooksOnly(channel, data);
        }
    }
    /**
     * Đăng ký hook nhận event trước khi gửi về renderer.
     * WorkflowEngineService dùng để trigger workflow.
     * Returns an unsubscribe function to remove the hook.
     */
    static onBeforeSend(channel, callback) {
        if (!this.beforeSendHooks.has(channel)) {
            this.beforeSendHooks.set(channel, []);
        }
        const hooks = this.beforeSendHooks.get(channel);
        // Prevent duplicate registration of the same function reference
        if (!hooks.includes(callback)) {
            hooks.push(callback);
        }
        // Return unsubscribe function
        return () => {
            const arr = this.beforeSendHooks.get(channel);
            if (arr) {
                const idx = arr.indexOf(callback);
                if (idx >= 0)
                    arr.splice(idx, 1);
            }
        };
    }
    /**
     * Remove all before-send hooks (called on workspace switch to prevent accumulation).
     */
    static clearBeforeSendHooks() {
        this.beforeSendHooks.clear();
    }
    static send(channel, data) {
        // Fire before-send hooks (sync, không chặn send)
        const hooks = this.beforeSendHooks.get(channel);
        if (hooks && hooks.length > 0) {
            for (const hook of hooks) {
                try {
                    hook(data);
                }
                catch { }
            }
        }
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send(channel, data);
        }
    }
    /**
     * Send directly to renderer WITHOUT firing onBeforeSend hooks.
     * Used by HttpClientService to avoid infinite relay loop:
     *   Boss relay → Employee handlePushedEvent → send → hook → relay → loop!
     */
    static sendDirect(channel, data) {
        if (this.window && !this.window.isDestroyed()) {
            this.window.webContents.send(channel, data);
        }
    }
    /**
     * Fire onBeforeSend hooks ONLY — do NOT send to renderer.
     * Used when boss webhook fires while an employee workspace is active:
     * hooks relay the event to employees, but the renderer is showing
     * the employee workspace (employee's handlePushedEvent sends to renderer).
     */
    static fireHooksOnly(channel, data) {
        const hooks = this.beforeSendHooks.get(channel);
        if (hooks && hooks.length > 0) {
            for (const hook of hooks) {
                try {
                    hook(data);
                }
                catch { }
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
    static extractActionlistText(content) {
        if (!content || typeof content !== 'object')
            return '';
        try {
            const params = typeof content.params === 'string'
                ? JSON.parse(content.params)
                : (content.params || {});
            const template = params?.msg?.vi || '';
            if (template) {
                let values = [];
                // simpleInfos → single name replacement (most setting-change events)
                if (Array.isArray(params.simpleInfos) && params.simpleInfos.length > 0) {
                    values = params.simpleInfos.map((i) => String(i.dpn || ''));
                }
                // highLightsV2 → multi-name replacement (reminders, bulk actions, etc.)
                else if (Array.isArray(params.highLightsV2) && params.highLightsV2.length > 0) {
                    values = params.highLightsV2.map((h) => String(h.dpn || ''));
                }
                if (values.length > 0) {
                    // Replace %1$s, %2$s … (PHP sprintf positional format)
                    const formatted = template.replace(/%(\d+)\$s/g, (_, n) => values[parseInt(n, 10) - 1] || '');
                    if (formatted)
                        return formatted;
                }
                // Template exists but no values to substitute – return as-is
                if (template && !template.includes('%'))
                    return template;
            }
        }
        catch { }
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
    static async broadcastMessage(zaloId, message, options) {
        try {
            // ─── Resolve the correct DB path for saving ───────────────────────
            // Boss webhook (fromRelay=false): ALWAYS save to the default workspace DB.
            // This ensures the boss DB (source of truth) gets every message,
            // even when the user is viewing an employee workspace.
            let bossDbPath = null;
            let activeIsDefault = true;
            if (!options?.fromRelay) {
                try {
                    const WorkspaceManager = require('../utils/WorkspaceManager').default;
                    const wm = WorkspaceManager.getInstance();
                    activeIsDefault = wm.getActiveWorkspaceId() === 'default';
                    if (!activeIsDefault) {
                        const defaultWs = wm.getWorkspaceById('default');
                        if (defaultWs) {
                            bossDbPath = wm.resolveDbPath(defaultWs.dbPath || 'deplao-tool.db');
                        }
                    }
                }
                catch { }
            }
            // ─── Silent mode: skip if message already exists in DB ─────────────
            if (options?.silent) {
                const msgId = message.data?.msgId;
                if (msgId && DatabaseService_1.default.getInstance().hasMessage(zaloId, String(msgId))) {
                    return; // Already in DB → skip entirely (no save, no event, no download)
                }
                // New message but from old_messages/getGroupChatHistory → mark silent
                message._silent = true;
            }
            // ─── Early-detect webchat/msginfo.actionlist notifications ───────────────
            // Zalo sends general conversation notifications (group setting changes,
            // reminders, member actions, etc.) as regular "message" events with
            //   msgType = "webchat"  and  content.action = "msginfo.actionlist"
            // These must be displayed as centred notification pills for ALL thread types,
            // NOT as regular message bubbles.
            const earlyMsgType = String(message.data?.msgType || '');
            const earlyContent = message.data?.content;
            if (earlyMsgType === 'webchat' &&
                earlyContent && typeof earlyContent === 'object' &&
                earlyContent.action === 'msginfo.actionlist') {
                const systemText = EventBroadcaster.extractActionlistText(earlyContent);
                if (systemText && message.threadId) {
                    const sysMsgId = String(message.data?.msgId || `sys_wchat_${Date.now()}`);
                    const sysTs = parseInt(String(message.data?.ts)) || Date.now();
                    try {
                        DatabaseService_1.default.getInstance().saveSystemMessage(zaloId, message.threadId, sysMsgId, systemText, sysTs);
                    }
                    catch { }
                    // ── Auto-pin/unpin from actionlist webhook ──────────────────────
                    // Zalo gửi webhook này khi ai đó ghim/bỏ ghim tin nhắn trong hội thoại
                    // actionType = "action.groupchat.jump.msg" → ghim; title chứa "bỏ ghim" → unpin
                    try {
                        const wcParams = typeof earlyContent.params === 'string'
                            ? JSON.parse(earlyContent.params)
                            : (earlyContent.params || {});
                        const actions = wcParams?.actions || [];
                        const pinAction = actions.find((a) => a?.actionType === 'action.groupchat.jump.msg' ||
                            String(a?.actionType || '').includes('jump.msg'));
                        const titleText = String(earlyContent.title || '');
                        const isUnpin = titleText.toLowerCase().includes('bỏ ghim') ||
                            titleText.toLowerCase().includes('unpin') ||
                            titleText.toLowerCase().includes('removed pin');
                        if (pinAction?.actionData) {
                            const actionData = typeof pinAction.actionData === 'string'
                                ? JSON.parse(pinAction.actionData)
                                : pinAction.actionData;
                            const pinnedMsgId = String(actionData?.global_msg_id || actionData?.client_msg_id || '');
                            if (pinnedMsgId && pinnedMsgId !== '0') {
                                const db = DatabaseService_1.default.getInstance();
                                if (isUnpin) {
                                    db.unpinMessage(zaloId, message.threadId, pinnedMsgId);
                                    Logger_1.default.log(`[EventBroadcaster] Auto-unpinned msg ${pinnedMsgId} in thread ${message.threadId}`);
                                }
                                else {
                                    // Lấy tên người ghim từ highLightsV2
                                    const senderName = (wcParams?.highLightsV2?.[0]?.dpn ||
                                        wcParams?.simpleInfos?.[0]?.dpn || '');
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
                                        }
                                        catch { }
                                        if (!previewImage && (mt === 'photo' || mt === 'image')) {
                                            try {
                                                const p = JSON.parse(origMsg.content || '{}');
                                                previewImage = p?.params?.hd || p?.params?.rawUrl || p?.href || p?.thumb || '';
                                            }
                                            catch { }
                                        }
                                        if (!previewImage) {
                                            try {
                                                const p = JSON.parse(origMsg.content || '{}');
                                                previewText = p?.msg || p?.title || String(origMsg.content || '').slice(0, 200);
                                            }
                                            catch {
                                                previewText = String(origMsg.content || '').slice(0, 200);
                                            }
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
                                    }
                                    else {
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
                                    Logger_1.default.log(`[EventBroadcaster] Auto-pinned msg ${pinnedMsgId} in thread ${message.threadId} by ${senderName}`);
                                }
                                // Notify renderer to reload pins
                                EventBroadcaster.send('event:pinsUpdated', {
                                    zaloId,
                                    threadId: message.threadId,
                                });
                            }
                        }
                    }
                    catch (pinErr) {
                        Logger_1.default.warn(`[EventBroadcaster] Auto-pin parse error: ${pinErr.message}`);
                    }
                    // ── End auto-pin ────────────────────────────────────────────────
                    // Re-use event:groupEvent channel — it handles any threadId, not just groups
                    this.send('event:groupEvent', {
                        zaloId,
                        groupId: message.threadId,
                        eventType: 'webchat_info',
                        data: {},
                        systemText,
                        msgId: sysMsgId,
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
                    const action = contentObj?.action || '';
                    if (action === 'vote') {
                        const params = typeof contentObj.params === 'string'
                            ? JSON.parse(contentObj.params)
                            : (contentObj.params || {});
                        const pollId = String(params.pollId || '');
                        const question = params.question || '';
                        const voterName = params.dName || message.data?.dName || '';
                        const timestamp = parseInt(message.data?.ts) || Date.now();
                        const threadId = message.threadId || '';
                        const isSent = message.isSelf === true;
                        const newContent = typeof rawContent === 'object'
                            ? JSON.stringify(rawContent)
                            : String(rawContent || '');
                        if (pollId && threadId) {
                            const updated = DatabaseService_1.default.getInstance().updatePollVoteMessage(zaloId, threadId, pollId, newContent, voterName, question, timestamp, isSent);
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
                                Logger_1.default.log(`[EventBroadcaster] poll vote updated: pollId=${pollId} by ${voterName}`);
                                return; // Don't insert as new message
                            }
                        }
                    }
                }
                catch (pollErr) {
                    Logger_1.default.warn(`[EventBroadcaster] group.poll intercept error: ${pollErr.message}`);
                }
            }
            // ─────────────────────────────────────────────────────────────────────────
            // Lưu vào database — always target the boss (default) workspace DB
            if (bossDbPath) {
                DatabaseService_1.default.getInstance().withDbPath(bossDbPath, () => {
                    DatabaseService_1.default.getInstance().saveMessage(zaloId, message);
                    // markAsRead + updateContactProfile also in the correct DB
                    if (message.isSelf && message.threadId) {
                        try {
                            DatabaseService_1.default.getInstance().markAsRead(zaloId, message.threadId);
                        }
                        catch { }
                    }
                    if (!message.isSelf && message.type !== 1) {
                        const dName = message.data?.dName || '';
                        const senderInfo = message.data?.senderInfo;
                        const displayName = senderInfo?.displayName || senderInfo?.zaloName || senderInfo?.name || dName || '';
                        const avatarUrl = senderInfo?.avatar || senderInfo?.avatarUrl || '';
                        if (displayName) {
                            DatabaseService_1.default.getInstance().updateContactProfile(zaloId, message.threadId, displayName, avatarUrl);
                        }
                    }
                    if (message.type === 1) {
                        const groupId = message.threadId || '';
                        const groupInfo = message.data?.groupInfo || message.data?.group;
                        const groupName = groupInfo?.name || groupInfo?.groupName || message.data?.groupName || '';
                        const groupAvt = groupInfo?.avt || groupInfo?.avatar || '';
                        if (groupId && groupName) {
                            DatabaseService_1.default.getInstance().updateContactProfile(zaloId, groupId, groupName, groupAvt);
                        }
                    }
                });
                Logger_1.default.log(`[EventBroadcaster] Saved message to boss DB via withDbPath: ${bossDbPath}`);
            }
            else {
                await DatabaseService_1.default.getInstance().saveMessage(zaloId, message);
            }
            // ── Check if this message was sent by an employee (pending from relay) ──
            // This runs right after saveMessage so the row exists in DB
            if (message.data?.msgId) {
                const isSelfMsg = message.isSelf === true;
                if (!isSelfMsg) {
                    Logger_1.default.log(`[EventBroadcaster] ⚠️ message.isSelf=${message.isSelf} for msgId="${message.data.msgId}" — checking pending map anyway`);
                }
                try {
                    const HttpRelayService = require('./HttpRelayService').default;
                    Logger_1.default.log(`[EventBroadcaster] 🔍 Checking pendingEmployeeMsg: msgId="${message.data.msgId}", zaloId="${zaloId}", threadId="${message.threadId || ''}", isSelf=${message.isSelf}`);
                    const pendingEmp = HttpRelayService.consumePendingEmployeeMsg(message.data.msgId, zaloId, message.threadId || '');
                    Logger_1.default.log(`[EventBroadcaster] 🔍 consumePendingEmployeeMsg result: ${pendingEmp ? JSON.stringify({ employee_id: pendingEmp.employee_id, employee_name: pendingEmp.employee_name }) : 'NULL'}`);
                    if (pendingEmp) {
                        const empMsgId = String(message.data.msgId);
                        const db = DatabaseService_1.default.getInstance();
                        if (bossDbPath) {
                            db.withDbPath(bossDbPath, () => db.setMessageHandledByEmployee(zaloId, empMsgId, pendingEmp.employee_id));
                        }
                        else {
                            db.setMessageHandledByEmployee(zaloId, empMsgId, pendingEmp.employee_id);
                        }
                        Logger_1.default.log(`[EventBroadcaster] Tagged message ${empMsgId} as sent by employee ${pendingEmp.employee_id} (${pendingEmp.employee_name})`);
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
                }
                catch (empErr) {
                    Logger_1.default.warn(`[EventBroadcaster] pendingEmployeeMsg check error: ${empErr.message}`);
                }
            }
            // ── Debug: log bank card content để phân tích cấu trúc webhook ──
            const rawMsgTypeDbg = String(message.data?.msgType || '');
            if (rawMsgTypeDbg === 'chat.webcontent') {
                const bankContent = message.data?.content;
                const bankContentStr = typeof bankContent === 'object' ? JSON.stringify(bankContent) : String(bankContent || '');
                Logger_1.default.log(`[EventBroadcaster] 🏦 chat.webcontent content: ${bankContentStr.slice(0, 2000)}`);
            }
            // ── The following DB operations are SKIPPED when bossDbPath is set ──
            // (they were already done inside the withDbPath block above)
            if (!bossDbPath) {
                // Nếu là tin nhắn của chính mình (isSelf) → đánh dấu đã đọc ngay
                if (message.isSelf && message.threadId) {
                    try {
                        await DatabaseService_1.default.getInstance().markAsRead(zaloId, message.threadId);
                    }
                    catch { }
                }
                // Nếu có thông tin tên trong message → lưu ngay vào DB
                if (!message.isSelf && message.type !== 1) {
                    const dName = message.data?.dName || '';
                    const senderInfo = message.data?.senderInfo;
                    const displayName = senderInfo?.displayName || senderInfo?.zaloName || senderInfo?.name || dName || '';
                    const avatarUrl = senderInfo?.avatar || senderInfo?.avatarUrl || '';
                    if (displayName) {
                        DatabaseService_1.default.getInstance().updateContactProfile(zaloId, message.threadId, displayName, avatarUrl);
                        Logger_1.default.log(`[EventBroadcaster] Saved contact profile: ${message.threadId} → ${displayName}`);
                    }
                }
                // Cho group messages: cố gắng lấy tên nhóm từ groupInfo trong data
                if (message.type === 1) {
                    const groupId = message.threadId || '';
                    const groupInfo = message.data?.groupInfo || message.data?.group;
                    const groupName = groupInfo?.name || groupInfo?.groupName || message.data?.groupName || '';
                    const groupAvt = groupInfo?.avt || groupInfo?.avatar || '';
                    if (groupId && groupName) {
                        DatabaseService_1.default.getInstance().updateContactProfile(zaloId, groupId, groupName, groupAvt);
                        Logger_1.default.log(`[EventBroadcaster] Saved group profile: ${groupId} → ${groupName}`);
                    }
                }
            }
            // ─── Phân loại message: file hay ảnh ─────────────────────────────
            const contentRaw = message.data?.content;
            const rawMsgType = String(message.data?.msgType || '');
            const msgId = message.data?.msgId || '';
            // Skip file/image downloads for reminder and poll messages
            // Also skip when fromRelay — boss already downloads files and relays event:localPath separately
            const SKIP_DOWNLOAD_MSG_TYPES = ['chat.ecard', 'group.poll'];
            const shouldSkipDownload = !!options?.fromRelay || SKIP_DOWNLOAD_MSG_TYPES.includes(rawMsgType);
            // Card message (danh thiếp): chat.recommended / action contains "recommened"
            const CARD_MSG_TYPES = ['chat.recommended', 'chat.recommend'];
            const isCardMsg = CARD_MSG_TYPES.includes(rawMsgType) ||
                (contentRaw && typeof contentRaw === 'object' &&
                    String(contentRaw.action || '').includes('recommened'));
            // File message: share.file hoặc content có title + href (không có rawUrl/hd)
            // Loại trừ card messages để tránh download href=www.zaloapp.com
            // Video: chat.video.msg — download thumbnail + video file
            const isVideoMsg = rawMsgType === 'chat.video.msg' ||
                (contentRaw && typeof contentRaw === 'object' &&
                    contentRaw.href && String(contentRaw.href).includes('video') &&
                    contentRaw.thumb && !contentRaw.title);
            // Voice message: chat.voice — download audio file, KHÔNG phải ảnh/file
            const isVoiceMsg = rawMsgType === 'chat.voice';
            if (!shouldSkipDownload && isVoiceMsg && contentRaw && typeof contentRaw === 'object' && msgId) {
                const voiceHref = String(contentRaw.href || '');
                if (voiceHref) {
                    FileStorageService_1.default.downloadFile(zaloId, voiceHref, `voice_${msgId}.m4a`).then((localPath) => {
                        DatabaseService_1.default.getInstance().updateLocalPaths(zaloId, String(msgId), { file: localPath });
                        EventBroadcaster.send('event:localPath', {
                            zaloId, msgId: String(msgId), threadId: message.threadId,
                            localPaths: { file: localPath },
                        });
                        Logger_1.default.log(`[EventBroadcaster] Downloaded voice for msg ${msgId}: ${localPath}`);
                    }).catch((err) => Logger_1.default.warn(`[EventBroadcaster] Voice download failed for ${msgId}: ${err.message}`));
                }
            }
            if (!shouldSkipDownload && isVideoMsg && contentRaw && typeof contentRaw === 'object' && msgId) {
                const videoUrl = String(contentRaw.href || '');
                const thumbUrl = String(contentRaw.thumb || '');
                const downloads = [];
                // Download thumbnail (ảnh đại diện) trước → hiển thị ngay
                if (thumbUrl) {
                    downloads.push(FileStorageService_1.default.downloadImage(zaloId, thumbUrl, `thumb_${msgId}.jpg`).then((thumbPath) => {
                        if (thumbPath) {
                            DatabaseService_1.default.getInstance().updateLocalPaths(zaloId, String(msgId), { thumb: thumbPath });
                            EventBroadcaster.send('event:localPath', {
                                zaloId, msgId: String(msgId), threadId: message.threadId,
                                localPaths: { thumb: thumbPath },
                            });
                        }
                    }).catch((e) => Logger_1.default.warn(`[EventBroadcaster] Video thumb download failed for ${msgId}: ${e.message}`)));
                }
                // Download video file (background, không block)
                if (videoUrl) {
                    downloads.push(FileStorageService_1.default.downloadVideo(zaloId, videoUrl, `vid_${msgId}.mp4`).then((videoPath) => {
                        if (videoPath) {
                            DatabaseService_1.default.getInstance().updateLocalPaths(zaloId, String(msgId), { file: videoPath });
                            EventBroadcaster.send('event:localPath', {
                                zaloId, msgId: String(msgId), threadId: message.threadId,
                                localPaths: { file: videoPath },
                            });
                            Logger_1.default.log(`[EventBroadcaster] Downloaded video for msg ${msgId}: ${videoPath}`);
                        }
                    }).catch((e) => Logger_1.default.warn(`[EventBroadcaster] Video download failed for ${msgId}: ${e.message}`)));
                }
                Promise.allSettled(downloads).catch(() => { });
            }
            const FILE_MSG_TYPES = ['share.file', 'share.link', 'file'];
            // Helper: parse params field (may be string or object)
            const parseParams = (raw) => {
                if (!raw)
                    return {};
                if (typeof raw === 'string') {
                    try {
                        return JSON.parse(raw);
                    }
                    catch {
                        return {};
                    }
                }
                return raw;
            };
            const contentParams = contentRaw && typeof contentRaw === 'object' ? parseParams(contentRaw.params) : {};
            const isFileMsg = !isCardMsg && !isVideoMsg && !isVoiceMsg && (FILE_MSG_TYPES.includes(rawMsgType) ||
                (contentRaw && typeof contentRaw === 'object' &&
                    contentRaw.title && contentRaw.href &&
                    !contentParams.rawUrl && !contentParams.hd));
            // Ảnh: chat.photo, photo, image, hoặc content có href+params.hd/rawUrl
            // Cho phép có title (caption) — title là chú thích ảnh, không phải tên file
            const isPhoto = !isFileMsg && !isCardMsg && !isVideoMsg && !isVoiceMsg && (rawMsgType === 'chat.photo' || rawMsgType === 'photo' || rawMsgType === 'image' ||
                (contentRaw && typeof contentRaw === 'object' &&
                    (contentParams.rawUrl || contentParams.hd ||
                        (contentRaw.href && !contentRaw.title))));
            // ─── Download ảnh ─────────────────────────────────────────────
            if (!shouldSkipDownload && isPhoto && contentRaw && typeof contentRaw === 'object' && msgId) {
                const imgUrl = DatabaseService_1.default.extractImageUrlFromContent(contentRaw);
                if (imgUrl) {
                    FileStorageService_1.default.downloadImage(zaloId, imgUrl).then((localPath) => {
                        DatabaseService_1.default.getInstance().updateLocalPaths(zaloId, String(msgId), { main: localPath });
                        EventBroadcaster.send('event:localPath', { zaloId, msgId: String(msgId), threadId: message.threadId, localPaths: { main: localPath } });
                        Logger_1.default.log(`[EventBroadcaster] Downloaded image for msg ${msgId}: ${localPath}`);
                    }).catch((err) => Logger_1.default.warn(`[EventBroadcaster] Image download failed for ${msgId}: ${err.message}`));
                }
            }
            // Card message (chat.recommended): URLs (thumb, qrCodeUrl) are stable on Zalo CDN
            // No local download needed — use remote URLs directly in UI
            if (isCardMsg) {
                Logger_1.default.log(`[EventBroadcaster] Card message ${msgId}: using remote thumb/qrCode URLs directly`);
                // Save link to links table if this is a link card
                const cardAction = contentRaw?.action || '';
                if (cardAction === 'recommened.link') {
                    const titleRaw = String(contentRaw.title || '');
                    const hrefFromTitle = (titleRaw.match(/https?:\/\/\S+/i)?.[0] || '').trim();
                    const href = String(contentRaw.href || hrefFromTitle || '');
                    const params = (() => { try {
                        const p = contentRaw.params;
                        return typeof p === 'string' ? JSON.parse(p) : (p || {});
                    }
                    catch {
                        return {};
                    } })();
                    // Keep full title from sender (can be "url + newline + text"), fallback to preview title only when missing.
                    const title = String(titleRaw || params.mediaTitle || href);
                    const domain = String(params.src || '');
                    const thumbUrl = String(contentRaw.thumb || '');
                    if (href) {
                        const ts = parseInt(String(message.data?.ts)) || Date.now();
                        DatabaseService_1.default.getInstance().saveLink(zaloId, message.threadId, String(msgId), href, title, domain, thumbUrl, ts);
                        Logger_1.default.log(`[EventBroadcaster] Saved link for msg ${msgId}: ${href}`);
                    }
                }
            }
            // ─── Download file đính kèm ────────────────────────────────────
            if (!shouldSkipDownload && isFileMsg && contentRaw && typeof contentRaw === 'object' && msgId) {
                const fileHref = String(contentRaw.href || '');
                const fileTitle = String(contentRaw.title || '');
                if (fileHref && fileTitle) {
                    // Lấy extension từ params.fileExt hoặc từ tên file
                    const paramsData = (() => {
                        try {
                            const p = contentRaw.params;
                            return typeof p === 'string' ? JSON.parse(p) : (p || {});
                        }
                        catch {
                            return {};
                        }
                    })();
                    const extFromParams = paramsData.fileExt ? `.${paramsData.fileExt}` : '';
                    const extFromTitle = path.extname(fileTitle);
                    const finalExt = extFromParams || extFromTitle || '';
                    const safeFilename = (fileTitle.includes('.') ? fileTitle : `${fileTitle}${finalExt}`)
                        .replace(/[/\\?%*:|"<>]/g, '_').trim() || `file_${Date.now()}${finalExt}`;
                    FileStorageService_1.default.downloadFile(zaloId, fileHref, safeFilename).then((localPath) => {
                        DatabaseService_1.default.getInstance().updateLocalPaths(zaloId, String(msgId), { file: localPath, fileName: safeFilename });
                        EventBroadcaster.send('event:localPath', { zaloId, msgId: String(msgId), threadId: message.threadId, localPaths: { file: localPath, fileName: safeFilename } });
                        Logger_1.default.log(`[EventBroadcaster] Downloaded file for msg ${msgId}: ${localPath}`);
                    }).catch((err) => Logger_1.default.warn(`[EventBroadcaster] File download failed for ${msgId}: ${err.message}`));
                }
            }
            // Download attachments array nếu có
            if (!shouldSkipDownload && message.data?.attachments?.length > 0) {
                FileStorageService_1.default.downloadAttachments(zaloId, message.data.attachments).catch((err) => Logger_1.default.warn(`[EventBroadcaster] Failed to download attachments: ${err.message}`));
            }
            Logger_1.default.log(`[EventBroadcaster] broadcastMessage → event:message zaloId=${zaloId} msgId=${message.data?.msgId} isSelf=${message.isSelf} threadId=${message.threadId} fromRelay=${!!options?.fromRelay} activeIsDefault=${activeIsDefault}`);
            // fromRelay: skip onBeforeSend hooks to avoid infinite relay loop
            // (Boss relay → Employee broadcastMessage → send → hook → relay → loop)
            if (options?.fromRelay) {
                // Employee relay — NEVER called anymore (handled by saveRelayMessageToWorkspaceDb)
                this.sendDirect('event:message', { zaloId, message });
            }
            else if (!activeIsDefault) {
                // Boss webhook but employee workspace is active:
                // Fire hooks (to relay to employees) but DON'T send to renderer.
                // The employee's handlePushedEvent → sendDirect handles renderer display.
                this.fireHooksOnly('event:message', { zaloId, message });
            }
            else {
                // Boss webhook, default workspace is active: normal flow
                this.send('event:message', { zaloId, message });
            }
        }
        catch (error) {
            Logger_1.default.error(`[EventBroadcaster] broadcastMessage error: ${error.message}`);
        }
    }
    /**
     * Broadcast kết nối thành công
     */
    static broadcastConnected(zaloId, accountInfo) {
        Logger_1.default.log(`[EventBroadcaster] Broadcasting connected for ${zaloId}`);
        this.sendAware('event:connected', { zaloId, accountInfo });
    }
    /**
     * Broadcast ngắt kết nối
     */
    static broadcastDisconnected(zaloId, reason) {
        Logger_1.default.log(`[EventBroadcaster] Broadcasting disconnected for ${zaloId}`);
        this.sendAware('event:disconnected', { zaloId, reason: reason || 'Unknown' });
    }
    /**
     * Broadcast reaction
     * Persist to boss DB only when employee workspace is active (renderer won't handle it).
     * When boss workspace is active, the renderer receives event:reaction and saves via ipc.db.updateReaction.
     */
    static broadcastReaction(zaloId, reaction) {
        const { activeIsDefault } = this.resolveBossContext();
        // Only persist manually when renderer will NOT receive the event (employee WS active)
        if (!activeIsDefault) {
            try {
                const rData = reaction.data || {};
                const userId = String(rData.uidFrom || reaction.uidFrom || '');
                const rMsg = rData.content?.rMsg || reaction.content?.rMsg || [];
                const targetMsgId = rMsg.length > 0
                    ? String(rMsg[0].gMsgID || rMsg[0].cMsgID || '')
                    : String(rData.msgId || reaction.msgId || '');
                const rawIcon = rData.content?.rIcon || reaction.content?.rIcon || reaction.rIcon || rData.rIcon || '';
                const ICON_MAP = {
                    '/-heart': '❤️', '/-strong': '👍', ':>': '😆', ':o': '😮',
                    ':-((': '😢', ':-h': '😡', ':-*': '😘', ":')": '😂',
                    '/-shit': '💩', '/-rose': '🌹', '/-break': '💔', '/-weak': '👎',
                    ';xx': '😍', ';-/': '😕', ';-)': '😉', '/-fade': '🥱',
                    '_()_': '🙏', '/-no': '🙅', '/-ok': '👌', '/-v': '✌️',
                    '/-thanks': '🙏', '/-punch': '👊', ':-bye': '👋', ':((': '😭',
                    ':))': '😁', '$-)': '🤑',
                };
                const emoji = ICON_MAP[rawIcon] || rawIcon;
                if (userId && targetMsgId) {
                    this.runOnBossDb((db) => {
                        db.updateMessageReaction(zaloId, targetMsgId, userId, emoji);
                    });
                }
            }
            catch (err) {
                Logger_1.default.warn(`[EventBroadcaster] broadcastReaction DB persist error: ${err.message}`);
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
    static broadcastFriendRequest(zaloId, requester) {
        const { userId, displayName, avatar, phoneNumber, msg } = requester;
        if (!userId) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastFriendRequest: no userId`);
            return;
        }
        try {
            this.runOnBossDb((db) => db.upsertFriendRequest(zaloId, { userId, displayName: displayName || '', avatar: avatar || '', phone: phoneNumber || '', msg: msg || '', createdAt: Date.now() }, 'received'));
            Logger_1.default.log(`[EventBroadcaster] Auto-saved friend request from ${userId} (${displayName}) msg="${msg}" for ${zaloId}`);
        }
        catch (err) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastFriendRequest DB save error: ${err.message}`);
        }
        this.sendAware('event:friendRequest', { zaloId, requester });
    }
    /**
     * Broadcast khi mình gửi lời mời kết bạn thành công.
     * Cache vào friend_requests(direction='sent') + broadcast realtime cho UI.
     */
    static broadcastFriendRequestSent(zaloId, requester) {
        const { userId, displayName, avatar, phoneNumber, msg } = requester;
        if (!userId) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastFriendRequestSent: no userId`);
            return;
        }
        try {
            this.runOnBossDb((db) => db.upsertFriendRequest(zaloId, {
                userId,
                displayName: displayName || '',
                avatar: avatar || '',
                phone: phoneNumber || '',
                msg: msg || '',
                createdAt: Date.now(),
            }, 'sent'));
            Logger_1.default.log(`[EventBroadcaster] Auto-saved sent friend request to ${userId} (${displayName}) for ${zaloId}`);
        }
        catch (err) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastFriendRequestSent DB save error: ${err.message}`);
        }
        this.sendAware('event:friendRequestSent', { zaloId, requester });
    }
    /**
     * Broadcast khi lời mời kết bạn bị xoá khỏi cache local.
     * Dùng cho REJECT_REQUEST / huỷ lời mời / đối phương thu hồi lời mời.
     */
    static broadcastFriendRequestRemoved(zaloId, payload) {
        const userId = String(payload.userId || '');
        const direction = payload.direction || 'sent';
        if (!userId) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastFriendRequestRemoved: no userId`);
            return;
        }
        try {
            this.runOnBossDb((db) => {
                if (direction === 'all') {
                    db.removeFriendRequest(zaloId, userId, 'received');
                    db.removeFriendRequest(zaloId, userId, 'sent');
                }
                else {
                    db.removeFriendRequest(zaloId, userId, direction);
                }
            });
            Logger_1.default.log(`[EventBroadcaster] Removed ${direction} friend request for ${userId} on ${zaloId} (reason=${payload.reason || 'unknown'})`);
        }
        catch (err) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastFriendRequestRemoved error: ${err.message}`);
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
    static broadcastFriendAccepted(zaloId, friend) {
        const { userId, displayName, avatar, phoneNumber } = friend;
        if (!userId)
            return;
        try {
            this.runOnBossDb((db) => db.addFriend(zaloId, { userId, displayName: displayName || '', avatar: avatar || '', phone: phoneNumber || '' }));
            Logger_1.default.log(`[EventBroadcaster] Friend accepted: ${userId} (${displayName}) added to friends for ${zaloId}`);
        }
        catch (err) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastFriendAccepted addFriend error: ${err.message}`);
        }
        try {
            this.runOnBossDb((db) => {
                db.removeFriendRequest(zaloId, userId, 'sent');
                db.removeFriendRequest(zaloId, userId, 'received');
            });
        }
        catch { }
        this.sendAware('event:friendAccepted', { zaloId, userId, requester: friend });
    }
    /**
     * Broadcast khi bạn bè bị xóa (FriendEventType.REMOVE = 1).
     * Remove from friends DB.
     */
    static broadcastFriendRemoved(zaloId, friendId) {
        if (!friendId)
            return;
        try {
            this.runOnBossDb((db) => db.removeFriend(zaloId, friendId));
            Logger_1.default.log(`[EventBroadcaster] Friend removed: ${friendId} for ${zaloId}`);
        }
        catch (err) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastFriendRemoved error: ${err.message}`);
        }
    }
    /**
     * Broadcast group info update (name, avatar, members)
     */
    static broadcastGroupInfoUpdate(zaloId, groupId, name, avatar, data) {
        this.sendAware('event:groupInfoUpdate', { zaloId, groupId, name, avatar, data });
    }
    /**
     * Broadcast group event — also saves a system message to DB
     */
    static broadcastGroupEvent(zaloId, groupId, eventType, rawEvent) {
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
                Logger_1.default.log(`[EventBroadcaster] ⏰ Reminder notification from group_event: thread=${groupId} emoji="${emoji}" msg="${msg}"`);
                this.broadcastReminderNotification(zaloId, groupId, 'chat.ecard', content);
            }
            catch (err) {
                Logger_1.default.warn(`[EventBroadcaster] remind_topic broadcast error: ${err.message}`);
            }
        }
        const systemText = EventBroadcaster.generateGroupEventText(eventType, rawEvent, zaloId, groupId);
        const msgId = `sys_${eventType}_${groupId}_${Date.now()}`;
        const timestamp = Date.now();
        if (eventType === 'new_pin_topic' || eventType === 'update_pin_topic') {
            try {
                const d = rawEvent?.data || rawEvent || {};
                const topic = d.topic;
                if (topic && groupId) {
                    let noteTitle = '';
                    try {
                        noteTitle = JSON.parse(topic.params || '{}').title || '';
                    }
                    catch { }
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
                        }
                        catch (dbErr) {
                            Logger_1.default.warn(`[EventBroadcaster] save note pin to DB error: ${dbErr.message}`);
                        }
                    }
                    this.sendAware('event:groupEvent', {
                        zaloId, groupId, eventType: 'new_pin_topic',
                        notePin: { topicId, title: noteTitle || topicId, creatorId, createTime, editTime: Number(topic.editTime || Date.now()) },
                        data: rawEvent, systemText: '', msgId, timestamp,
                    });
                    Logger_1.default.log(`[EventBroadcaster] Pinned topic ${topic.id} ("${noteTitle}") in group ${groupId}`);
                }
            }
            catch (err) {
                Logger_1.default.warn(`[EventBroadcaster] pin_topic broadcast error: ${err.message}`);
            }
        }
        else if (eventType === 'unpin_topic') {
            try {
                const d = rawEvent?.data || rawEvent || {};
                const topic = d.topic;
                if (topic && groupId) {
                    const topicId = String(topic.id || topic.topicId || '');
                    if (topicId) {
                        try {
                            this.runOnBossDb((db) => db.unpinMessage(zaloId, groupId, `note_${topicId}`));
                        }
                        catch { }
                        this.sendAware('event:groupEvent', {
                            zaloId, groupId, eventType: 'unpin_topic', notePin: { topicId },
                            data: rawEvent, systemText: '', msgId, timestamp,
                        });
                        Logger_1.default.log(`[EventBroadcaster] Unpinned topic ${topicId} in group ${groupId}`);
                    }
                }
            }
            catch (err) {
                Logger_1.default.warn(`[EventBroadcaster] unpin_topic broadcast error: ${err.message}`);
            }
        }
        if (eventType === 'update_board' || eventType === 'update_topic') {
            try {
                const d = rawEvent?.data || rawEvent || {};
                const topic = d.groupTopic || d.topic;
                if (topic && groupId) {
                    let noteTitle = '';
                    try {
                        noteTitle = JSON.parse(topic.params || '{}').title || '';
                    }
                    catch { }
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
                                }
                                catch { }
                            }
                            this.sendAware('event:groupEvent', {
                                zaloId, groupId, eventType: 'new_pin_topic',
                                notePin: { topicId, title: noteTitle || topicId, creatorId, createTime, editTime: Number(topic.editTime || Date.now()) },
                                data: rawEvent, systemText: '', msgId, timestamp,
                            });
                        }
                        else if (action === 0) {
                            try {
                                this.runOnBossDb((db) => db.unpinMessage(zaloId, groupId, `note_${topicId}`));
                            }
                            catch { }
                            this.sendAware('event:groupEvent', {
                                zaloId, groupId, eventType: 'unpin_topic', notePin: { topicId },
                                data: rawEvent, systemText: '', msgId, timestamp,
                            });
                        }
                    }
                }
            }
            catch (err) {
                Logger_1.default.warn(`[EventBroadcaster] update_board topic error: ${err.message}`);
            }
        }
        if (systemText && groupId) {
            try {
                const d2 = rawEvent?.data || rawEvent || {};
                const um = d2.updateMembers || [];
                this.runOnBossDb((db) => db.saveSystemMessage(zaloId, groupId, msgId, systemText, timestamp, um.length > 0 ? um : undefined));
            }
            catch { }
        }
        const d = rawEvent?.data || rawEvent || {};
        const updateMembers = d.updateMembers || [];
        if (updateMembers.length > 0 && groupId) {
            const creatorId = d.creatorId || '';
            try {
                this.runOnBossDb((db) => {
                    for (const um of updateMembers) {
                        const uid = um.id || '';
                        if (!uid)
                            continue;
                        switch (eventType) {
                            case 'join':
                                db.upsertGroupMember(zaloId, groupId, { memberId: uid, displayName: um.dName || um.zaloName || '', avatar: um.avatar || um.avatar_25 || '', role: 0 });
                                break;
                            case 'leave':
                            case 'remove_member':
                            case 'block_member':
                                db.removeGroupMember(zaloId, groupId, uid);
                                break;
                            case 'add_admin':
                                db.upsertGroupMember(zaloId, groupId, { memberId: uid, displayName: um.dName || um.zaloName || '', avatar: um.avatar || um.avatar_25 || '', role: 2 });
                                break;
                            case 'remove_admin':
                                db.upsertGroupMember(zaloId, groupId, { memberId: uid, displayName: um.dName || um.zaloName || '', avatar: um.avatar || um.avatar_25 || '', role: uid === creatorId ? 1 : 0 });
                                break;
                        }
                    }
                });
            }
            catch (err) {
                Logger_1.default.warn(`[EventBroadcaster] Surgical member DB update failed: ${err.message}`);
            }
        }
        this.sendAware('event:groupEvent', { zaloId, groupId, eventType, data: rawEvent, systemText, msgId, timestamp });
        const CACHE_INVALIDATING_EVENTS = new Set([
            'join', 'leave', 'remove_member', 'block_member',
            'add_admin', 'remove_admin', 'update_setting', 'update', 'update_avatar',
        ]);
        if (groupId && CACHE_INVALIDATING_EVENTS.has(eventType) && _invalidateGroupCacheFn) {
            _invalidateGroupCacheFn(zaloId, groupId);
        }
    }
    static generateGroupEventText(eventType, rawEvent, zaloId, groupId) {
        // data is inside rawEvent.data for most event types
        const d = rawEvent?.data || rawEvent || {};
        const updateMembers = d.updateMembers || [];
        const memberNames = updateMembers.map((m) => m.dName || m.zaloName || m.id || '').filter(Boolean).join(', ');
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
                const newSettings = d.groupSetting || {};
                const extraData = d.extraData || {};
                const featureId = extraData.featureId !== undefined
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
                            return labels[val] || '';
                        }
                    }
                    // Unknown featureId — fall through to diff approach below
                    // (do NOT silently return '' – we may still have prev state to diff against)
                }
                // ── No featureId: diff against previous cached settings ─────────────
                if (prevSettings && Object.keys(newSettings).length > 0) {
                    const messages = [];
                    for (const [key, labels] of Object.entries(EventBroadcaster.VISIBLE_SETTINGS)) {
                        const newVal = newSettings[key];
                        const prevVal = prevSettings[key];
                        if (newVal !== undefined && prevVal !== undefined && newVal !== prevVal) {
                            messages.push(labels[newVal] || '');
                        }
                    }
                    const filtered = messages.filter(Boolean);
                    if (filtered.length > 0)
                        return filtered.join('\n');
                }
                // No previous state or no visible changes detected → silent
                return '';
            }
            case 'new_link': {
                const link = d.link || d.inviteLink || d.groupLink || d.linkJoin
                    || d.info?.group_link || '';
                if (link)
                    return `Link mới tham gia nhóm: ${link}`;
                return 'Link nhóm mới đã được tạo';
            }
            case 'update':
            case 'update_avatar': {
                const subType = d.subType || 0;
                const groupName = d.groupName || '';
                if (subType === 1 && groupName)
                    return `Tên nhóm đã được đổi thành "${groupName}"`;
                if (subType === 2 || d.avt || d.fullAvt)
                    return 'Ảnh nhóm đã được thay đổi';
                if (groupName)
                    return `Tên nhóm đã được đổi thành "${groupName}"`;
                return 'Nhóm đã được cập nhật';
            }
            case 'add_admin':
                return `${actor} đã được thêm làm phó nhóm`;
            case 'remove_admin':
                return `${actor} đã bị xóa khỏi vai trò phó nhóm`;
            case 'join_request': {
                const uids = d.uids || [];
                const total = d.totalPending || uids.length || 1;
                return `${total} người đang chờ phê duyệt vào nhóm`;
            }
            case 'remind_topic': {
                const emoji = d.emoji || '⏰';
                const msg = d.msg || '';
                let title = '';
                try {
                    title = msg ? JSON.parse(msg) : '';
                }
                catch {
                    title = msg;
                }
                return title ? `${emoji} ${title}` : `${emoji} Nhắc hẹn`;
            }
            default:
                return '';
        }
    }
    /**
     * Broadcast undo message - marks as recalled in DB (keeps the row, changes status/type)
     */
    static broadcastUndo(zaloId, msgId, threadId) {
        if (msgId) {
            this.runOnBossDb((db) => {
                db.markMessageRecalled(zaloId, String(msgId));
                if (threadId) {
                    try {
                        db.updateLastMessageIfRecalled(zaloId, threadId, String(msgId));
                    }
                    catch { }
                }
            });
            Logger_1.default.log(`[EventBroadcaster] broadcastUndo: recalled msgId=${msgId} zaloId=${zaloId} threadId=${threadId}`);
        }
        this.sendAware('event:undo', { zaloId, msgId, threadId });
    }
    /**
     * Broadcast delete messages (chat.delete event) - marks as recalled in DB and notifies renderer.
     * Không xoá khỏi DB để giữ lịch sử — chỉ đánh dấu recalled.
     */
    static broadcastDeleteMessages(zaloId, msgIds, threadId) {
        if (msgIds.length > 0) {
            this.runOnBossDb((db) => {
                for (const msgId of msgIds) {
                    db.markMessageRecalled(zaloId, String(msgId));
                    try {
                        db.updateLastMessageIfRecalled(zaloId, threadId, String(msgId));
                    }
                    catch { }
                }
            });
            Logger_1.default.log(`[EventBroadcaster] broadcastDeleteMessages: marked ${msgIds.length} msgs as recalled in thread=${threadId}`);
        }
        this.sendAware('event:delete', { zaloId, msgIds, threadId });
    }
    /**
     * Broadcast reminder notification (chat.ecard event) - show full-screen notification
     */
    static broadcastReminderNotification(zaloId, threadId, msgType, content) {
        Logger_1.default.log(`[EventBroadcaster] broadcastReminderNotification: zaloId=${zaloId} threadId=${threadId}`);
        this.send('event:reminder', { zaloId, threadId, msgType, content });
    }
    /**
     * Broadcast typing event
     */
    static broadcastTyping(zaloId, data) {
        // zca-js Typing model:
        //   UserTyping:  { type: ThreadType.User,  threadId, isSelf, data: { uid, ts, isPC } }
        //   GroupTyping: { type: ThreadType.Group, threadId, isSelf, data: { uid, gid, ts, isPC } }
        try {
            const isGroup = data?.type === 1 || !!(data?.data?.gid);
            const threadId = data?.threadId
                || data?.data?.gid // GroupTyping
                || data?.data?.idTo // fallback
                || data?.data?.uidFrom
                || '';
            const userId = data?.data?.uid || data?.data?.uidFrom || data?.uidFrom || '';
            Logger_1.default.log(`[EventBroadcaster] typing: zaloId=${zaloId} threadId=${threadId} userId=${userId} isGroup=${isGroup}`);
            if (threadId && userId)
                this.send('event:typing', { zaloId, threadId, userId, isGroup });
        }
        catch { }
    }
    /**
     * Broadcast seen/read event
     * Phân biệt 2 model theo docs:
     *   UserSeenMessage  (type=0): data = { idTo, msgId, realMsgId }  → 1 người seen = người dùng kia
     *   GroupSeenMessage (type=1): data = { msgId, groupId, seenUids[] } → nhiều người seen trong nhóm
     */
    static broadcastSeen(zaloId, data) {
        try {
            const isGroup = data?.type === 1 || data?.data?.groupId;
            if (isGroup) {
                // GroupSeenMessage
                const threadId = data?.threadId || data?.data?.groupId || '';
                const msgId = data?.data?.msgId || data?.msgId || '';
                const seenUids = data?.data?.seenUids || [];
                if (threadId) {
                    this.send('event:seen', { zaloId, threadId, msgId, isGroup: true, seenUids });
                }
            }
            else {
                // UserSeenMessage
                const threadId = data?.threadId || data?.data?.idTo || data?.data?.uidFrom || '';
                const msgId = data?.data?.msgId || data?.data?.realMsgId || data?.msgId || '';
                // userId = người đối diện đã seen (không phải mình)
                const userId = data?.data?.uidFrom || data?.uidFrom || threadId;
                if (threadId) {
                    this.send('event:seen', { zaloId, threadId, msgId, isGroup: false, seenUids: [userId] });
                }
            }
        }
        catch (e) {
            Logger_1.default.warn(`[EventBroadcaster] broadcastSeen error: ${e.message}`);
        }
    }
    /**
     * Broadcast QR code update
     */
    static broadcastQRUpdate(tempId, qrDataUrl, status) {
        this.send('qr:update', { tempId, qrDataUrl, status });
    }
    /**
     * Broadcast listener dead (max retries exhausted or fatal token error)
     * → renderer hiển thị cảnh báo và nút reconnect thủ công
     */
    static broadcastListenerDead(zaloId, reason) {
        Logger_1.default.warn(`[EventBroadcaster] broadcastListenerDead: ${zaloId} reason=${reason}`);
        this.send('event:listenerDead', { zaloId, reason });
    }
}
EventBroadcaster.window = null;
/** Cache previous groupSetting per group to detect what changed in update_setting events */
EventBroadcaster.previousGroupSettings = new Map();
/** Hooks đăng ký bởi WorkflowEngineService để nhận event trước renderer */
EventBroadcaster.beforeSendHooks = new Map();
/**
 * Settings that produce a visible system message in Zalo's chat.
 * Value [0] = text when turned off, [1] = text when turned on.
 */
EventBroadcaster.VISIBLE_SETTINGS = {
    joinAppr: ['Hình thức tham gia nhóm: Không cần phê duyệt', 'Hình thức tham gia nhóm: Cần phê duyệt'],
    lockSendMsg: ['Đã mở khóa gửi tin nhắn cho thành viên', 'Đã khóa gửi tin nhắn cho thành viên'],
    blockName: ['Cho phép thành viên đổi tên nhóm', 'Đã khóa đổi tên nhóm'],
    addMemberOnly: ['Thành viên có thể thêm người vào nhóm', 'Chỉ trưởng/phó nhóm mới được thêm thành viên'],
    setTopicOnly: ['Thành viên có thể đặt chủ đề nhóm', 'Chỉ trưởng/phó nhóm mới được đặt chủ đề'],
    lockCreatePost: ['Thành viên có thể đăng bài', 'Chỉ trưởng/phó nhóm mới được đăng bài'],
    lockCreatePoll: ['Thành viên có thể tạo bình chọn', 'Chỉ trưởng/phó nhóm mới được tạo bình chọn'],
    lockViewMember: ['Thành viên có thể xem danh sách thành viên', 'Đã ẩn danh sách thành viên'],
};
/**
 * featureId values from extraData that map to INVISIBLE settings
 * (Zalo does NOT show a chat message for these setting changes).
 */
EventBroadcaster.INVISIBLE_FEATURE_IDS = new Set([
    25, // enableMsgHistory
]);
/** Maps known featureId values to a groupSetting key */
EventBroadcaster.FEATURE_ID_TO_KEY = {
    25: 'enableMsgHistory',
};
exports.default = EventBroadcaster;
//# sourceMappingURL=EventBroadcaster.js.map