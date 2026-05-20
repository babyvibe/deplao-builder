"use strict";
/**
 * FacebookService.ts
 * Orchestrator singleton per account
 * Tương tự ZaloService — quản lý lifecycle session + listener + API calls
 */
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
exports.FacebookService = void 0;
const FacebookSession_1 = require("./FacebookSession");
const FacebookMessageSender_1 = require("./FacebookMessageSender");
const FacebookAttachment_1 = require("./FacebookAttachment");
const FacebookThreadManager_1 = require("./FacebookThreadManager");
const FacebookMQTTListener_1 = require("./FacebookMQTTListener");
const EventBroadcaster_1 = __importDefault(require("../EventBroadcaster"));
const DatabaseService_1 = __importDefault(require("../DatabaseService"));
const Logger_1 = __importDefault(require("../../utils/Logger"));
class FacebookService {
    constructor(accountId, cookie) {
        this.dataFB = null;
        this.listener = null;
        this.status = 'disconnected';
        /** Cached real Facebook UID — resolved once from DB, used for broadcasts */
        this._facebookId = null;
        this.accountId = accountId;
        this.cookie = cookie;
    }
    /** Get real Facebook UID for broadcasts (cached) */
    getFacebookId() {
        if (!this._facebookId) {
            try {
                const fbAcc = DatabaseService_1.default.getInstance().getFBAccount(this.accountId);
                if (fbAcc?.facebook_id)
                    this._facebookId = fbAcc.facebook_id;
            }
            catch { }
        }
        return this._facebookId || this.accountId;
    }
    static getInstance(accountId, cookie) {
        if (!FacebookService.instances.has(accountId)) {
            if (!cookie)
                throw new Error(`[FacebookService] Cookie required for new instance: ${accountId}`);
            FacebookService.instances.set(accountId, new FacebookService(accountId, cookie));
        }
        return FacebookService.instances.get(accountId);
    }
    static removeInstance(accountId) {
        const instance = FacebookService.instances.get(accountId);
        if (instance) {
            instance.disconnect().catch(() => { });
            FacebookService.instances.delete(accountId);
        }
    }
    static getAllInstances() {
        return Array.from(FacebookService.instances.values());
    }
    onStatusChange(cb) {
        this.statusChangeCallback = cb;
    }
    setStatus(status) {
        this.status = status;
        EventBroadcaster_1.default.emit('fb:onConnectionStatus', {
            fbAccountId: this.getFacebookId(),
            status,
        });
        this.statusChangeCallback?.(status);
    }
    /**
     * Kết nối: init session + start MQTT listener
     */
    async connect() {
        if (this.status === 'connected' || this.status === 'connecting') {
            Logger_1.default.log(`[FacebookService:${this.accountId}] Already connected/connecting`);
            return;
        }
        this.setStatus('connecting');
        Logger_1.default.log(`[FacebookService:${this.accountId}] Connecting...`);
        try {
            // 1. Init session
            this.dataFB = await (0, FacebookSession_1.initSession)(this.cookie);
            const fbId = this.dataFB.FacebookID;
            if (!fbId || fbId.includes('Unable') || !fbId.match(/^\d+$/)) {
                this.setStatus('cookie_expired');
                throw new Error('Cookie expired or invalid — cannot parse FacebookID');
            }
            // 2. Fetch latest seqId via GraphQL to avoid ERROR_QUEUE_OVERFLOW
            // Sending seq=0 asks Facebook to sync ALL messages → overflow on accounts with many messages
            let seqId = '0';
            try {
                const { getLastSeqId } = await Promise.resolve().then(() => __importStar(require('./FacebookThreadManager')));
                seqId = await getLastSeqId(this.dataFB);
                Logger_1.default.log(`[FacebookService:${this.accountId}] Got lastSeqId=${seqId}`);
            }
            catch (seqErr) {
                Logger_1.default.warn(`[FacebookService:${this.accountId}] Failed to get lastSeqId, using 0: ${seqErr.message}`);
            }
            // 3. Start MQTT listener
            this.listener = new FacebookMQTTListener_1.FacebookMQTTListener(this.dataFB, this.accountId, seqId);
            this.listener.on('message', (msg) => {
                this.handleIncomingMessage(msg);
            });
            this.listener.on('connectionStatus', (s) => {
                if (s === 'connected') {
                    this.setStatus('connected');
                }
                else if (s === 'cookie_expired') {
                    Logger_1.default.warn(`[FacebookService:${this.accountId}] MQTT max retries — cookie expired or bot detected`);
                    this.setStatus('cookie_expired');
                }
                else if (s === 'error') {
                    this.setStatus('error');
                }
            });
            this.listener.on('error', (err) => {
                Logger_1.default.warn(`[FacebookService:${this.accountId}] Listener error: ${err.message}`);
            });
            this.listener.connect();
            Logger_1.default.log(`[FacebookService:${this.accountId}] Connected (fbId=${fbId})`);
        }
        catch (err) {
            Logger_1.default.error(`[FacebookService:${this.accountId}] Connect error: ${err.message}`);
            if (this.status !== 'cookie_expired') {
                this.setStatus('error');
            }
            throw err;
        }
    }
    /**
     * Ngắt kết nối
     */
    async disconnect() {
        if (this.listener) {
            this.listener.disconnect();
            this.listener = null;
        }
        this.setStatus('disconnected');
        Logger_1.default.log(`[FacebookService:${this.accountId}] Disconnected`);
    }
    /**
     * Health check: kiểm tra cookie + listener
     */
    async checkHealth() {
        try {
            const cookieAlive = await (0, FacebookSession_1.checkCookieAlive)(this.cookie);
            const listenerConnected = this.listener?.isConnected() || false;
            if (!cookieAlive) {
                return { alive: false, listenerConnected, reason: 'cookie_expired' };
            }
            return { alive: true, listenerConnected };
        }
        catch (err) {
            return { alive: false, listenerConnected: false, reason: err.message };
        }
    }
    /**
     * Cập nhật cookie (sau khi user re-login)
     */
    async updateCookie(newCookie) {
        this.cookie = newCookie;
        await this.disconnect();
        await this.connect();
    }
    handleIncomingMessage(msg) {
        const threadId = msg.replyToID && msg.replyToID !== '0' ? msg.replyToID : null;
        const ts = parseInt(msg.timestamp) || Date.now();
        const isSelf = this.dataFB?.FacebookID && msg.userID === this.dataFB.FacebookID ? 1 : 0;
        Logger_1.default.log(`[FacebookService:${this.accountId}] handleIncomingMessage: msgId=${msg.messageID} threadId=${threadId} userID=${msg.userID} isSelf=${isSelf} body="${(msg.body || '').slice(0, 50)}" fbId=${this.dataFB?.FacebookID}`);
        // Persist to DB
        if (threadId && msg.messageID) {
            try {
                const db = DatabaseService_1.default.getInstance();
                const hasAttachment = !!(msg.attachments?.id && msg.attachments.id !== 0 &&
                    (msg.attachments.url || msg.attachments.attachmentType));
                // Determine type from attachment (use primary attachment)
                const msgType = hasAttachment
                    ? (msg.attachments.attachmentType || 'image')
                    : 'text';
                // Build attachment payload — support multiple attachments (batch image send)
                let attachmentPayload;
                if (msg.allAttachments && msg.allAttachments.length > 1) {
                    attachmentPayload = JSON.stringify(msg.allAttachments.map(a => ({
                        type: a.attachmentType || msgType,
                        url: a.url,
                        id: String(a.id),
                        ...(a.name ? { name: a.name } : {}),
                        ...(a.fileSize != null ? { fileSize: a.fileSize } : {}),
                        ...(a.mimeType ? { mimeType: a.mimeType } : {}),
                    })));
                }
                else if (hasAttachment) {
                    attachmentPayload = JSON.stringify([{
                            type: msgType,
                            url: msg.attachments.url,
                            id: String(msg.attachments.id),
                            ...(msg.attachments.name ? { name: msg.attachments.name } : {}),
                            ...(msg.attachments.fileSize != null ? { fileSize: msg.attachments.fileSize } : {}),
                            ...(msg.attachments.mimeType ? { mimeType: msg.attachments.mimeType } : {}),
                        }]);
                }
                // Human-readable preview for last_message display
                const attachmentPreview = msgType === 'image' ? '🖼️ Hình ảnh'
                    : msgType === 'video' ? '🎬 Video'
                        : msgType === 'audio' ? '🎵 Audio'
                            : msg.attachments?.name ? `📎 ${msg.attachments.name}`
                                : '📎 Tệp đính kèm';
                Logger_1.default.log(`[FacebookService:${this.accountId}] Calling saveFBMessage: account_id=${this.accountId} thread_id=${threadId} type=${msgType} hasAttachment=${hasAttachment}`);
                // @ts-ignore
                db.saveFBMessage({
                    id: msg.messageID,
                    account_id: this.accountId,
                    thread_id: threadId,
                    sender_id: msg.userID || '',
                    body: msg.body || (hasAttachment ? attachmentPreview : undefined),
                    timestamp: ts,
                    type: msgType,
                    attachments: attachmentPayload,
                    is_self: isSelf,
                    is_unsent: 0,
                });
                // Note: fb_threads preview is updated inside saveFBMessage
                // Sync to unified contacts table
                const fbThread = db.queryOne?.(`SELECT name, type FROM fb_threads WHERE id = ? AND account_id = ?`, [threadId, this.accountId]);
                const threadName = fbThread?.name || '';
                const contactType = fbThread?.type === 'group' ? 'group' : 'user';
                const fbIdForContacts = this.getFacebookId();
                const lastMsgText = msg.body || (hasAttachment ? attachmentPreview : '');
                Logger_1.default.log(`[FacebookService:${this.accountId}] Syncing contacts: owner=${fbIdForContacts} thread=${threadId} name=${threadName} type=${contactType}`);
                db.run?.(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
           VALUES (?, ?, ?, '', 0, ?, ?, ?, ?, 'facebook')
           ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
             display_name = CASE WHEN excluded.display_name != '' AND contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
             last_message = excluded.last_message,
             last_message_time = excluded.last_message_time,
             unread_count = CASE WHEN ? = 0 THEN contacts.unread_count + 1 ELSE contacts.unread_count END,
             channel = 'facebook'`, [this.getFacebookId(), threadId, threadName, contactType, isSelf ? 0 : 1, lastMsgText.slice(0, 200), ts, isSelf]);
            }
            catch (err) {
                Logger_1.default.warn(`[FacebookService:${this.accountId}] DB persist error: ${err.message}`);
            }
        }
        // Broadcast — include isSelf so UI can place message on correct side
        EventBroadcaster_1.default.emit('fb:onMessage', {
            fbAccountId: this.getFacebookId(),
            message: { ...msg, isSelf: !!isSelf },
        });
        Logger_1.default.log(`[FacebookService:${this.accountId}] ${isSelf ? '[ECHO]' : 'Incoming'} message from ${msg.userID}: ${msg.body?.slice(0, 50) || (msg.attachments?.attachmentType ? `[${msg.attachments.attachmentType}${msg.attachments.name ? ': ' + msg.attachments.name : ''}]` : '[attachment]')}`);
    }
    // ─── Public API methods ──────────────────────────────────────────────────────
    requireSession() {
        if (!this.dataFB)
            throw new Error('Not connected — call connect() first');
        return this.dataFB;
    }
    async sendMessage(threadId, body, opts) {
        return (0, FacebookMessageSender_1.sendMessage)(this.requireSession(), threadId, body, opts);
    }
    async unsendMessage(messageId) {
        return (0, FacebookMessageSender_1.unsendMessage)(this.requireSession(), messageId);
    }
    async addReaction(messageId, emoji, action) {
        return (0, FacebookMessageSender_1.addReaction)(this.requireSession(), messageId, emoji, action);
    }
    async uploadAttachment(filePath) {
        return (0, FacebookAttachment_1.uploadAttachment)(this.requireSession(), filePath);
    }
    async getThreadList() {
        const session = this.requireSession();
        const result = await (0, FacebookThreadManager_1.getThreadList)(session);
        return (0, FacebookThreadManager_1.parseThreadNodes)(result.dataGet, this.accountId, session.FacebookID);
    }
    async changeThreadName(threadId, name) {
        return (0, FacebookThreadManager_1.changeThreadName)(this.requireSession(), threadId, name);
    }
    async changeThreadEmoji(threadId, emoji) {
        return (0, FacebookThreadManager_1.changeThreadEmoji)(this.requireSession(), threadId, emoji);
    }
    async changeNickname(threadId, userId, nickname) {
        return (0, FacebookThreadManager_1.changeNickname)(this.requireSession(), threadId, userId, nickname);
    }
    // ─── Getters ─────────────────────────────────────────────────────────────────
    getStatus() { return this.status; }
    getAccountId() { return this.accountId; }
    getRealFacebookId() { return this.dataFB?.FacebookID || null; }
    isConnected() { return this.status === 'connected'; }
}
exports.FacebookService = FacebookService;
FacebookService.instances = new Map();
exports.default = FacebookService;
//# sourceMappingURL=FacebookService.js.map