"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const DatabaseService_1 = __importDefault(require("./DatabaseService"));
const ConnectionManager_1 = __importDefault(require("../utils/ConnectionManager"));
const EventBroadcaster_1 = __importDefault(require("./EventBroadcaster"));
const Logger_1 = __importDefault(require("../utils/Logger"));
/**
 * CRMQueueService — chạy trong main process
 * Token bucket per account: max 60 tin/giờ, refill 1 token mỗi 60s
 * Dispatcher loop: kiểm tra mỗi 5s, nếu đủ delay → gửi 1 tin rồi đợi
 */
class CRMQueueService {
    constructor() {
        this.timers = new Map();
        this.lastSentAt = new Map();
        this.isProcessing = new Map();
        // Token bucket: max 60/giờ — refill 1 token mỗi 60s
        this.tokens = new Map();
        this.lastRefillAt = new Map();
        this.MAX_TOKENS = 60;
        this.REFILL_INTERVAL_MS = 60 * 1000; // 1 phút / token → 60/giờ
        this.CHECK_INTERVAL_MS = 5000; // kiểm tra mỗi 5s
        this.MIN_DELAY_MS = 30 * 1000; // tối thiểu 30s
    }
    static getInstance() {
        if (!CRMQueueService.instance)
            CRMQueueService.instance = new CRMQueueService();
        return CRMQueueService.instance;
    }
    /** Bắt đầu dispatcher cho account */
    startForAccount(zaloId) {
        if (this.timers.has(zaloId))
            return;
        Logger_1.default.log(`[CRMQueue] ▶ Starting queue for ${zaloId}`);
        if (!this.tokens.has(zaloId)) {
            this.tokens.set(zaloId, this.MAX_TOKENS);
            this.lastRefillAt.set(zaloId, Date.now());
        }
        else {
            // Queue đã từng chạy trước đó → refill ngay dựa trên thời gian đã qua
            this.refillTokens(zaloId);
        }
        const timer = setInterval(() => this.process(zaloId), this.CHECK_INTERVAL_MS);
        this.timers.set(zaloId, timer);
    }
    /** Dừng dispatcher cho account */
    stopForAccount(zaloId) {
        const timer = this.timers.get(zaloId);
        if (timer) {
            clearInterval(timer);
            this.timers.delete(zaloId);
        }
        // Clean up satellite maps to prevent unbounded memory growth
        this.lastSentAt.delete(zaloId);
        this.isProcessing.delete(zaloId);
        this.tokens.delete(zaloId);
        this.lastRefillAt.delete(zaloId);
        Logger_1.default.log(`[CRMQueue] ⏹ Stopped queue for ${zaloId}`);
        // Notify renderer so the status bar disappears
        EventBroadcaster_1.default.emit('crm:queueStatus', {
            zaloId,
            type: 'stopped',
            running: false,
            tokens: this.tokens.get(zaloId) ?? this.MAX_TOKENS,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
        });
    }
    /** Dừng nếu không còn campaign active */
    checkAndStopIfIdle(zaloId) {
        const hasActive = DatabaseService_1.default.getInstance().hasActiveCampaigns(zaloId);
        if (!hasActive)
            this.stopForAccount(zaloId);
    }
    getStatus(zaloId) {
        return {
            running: this.timers.has(zaloId),
            tokens: this.tokens.get(zaloId) ?? this.MAX_TOKENS,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
        };
    }
    /** Khởi động lại tất cả campaigns đang active (sau khi app restart) */
    resumeActiveCampaigns() {
        try {
            const owners = DatabaseService_1.default.getInstance().getActiveCampaignOwners();
            for (const zaloId of owners) {
                Logger_1.default.log(`[CRMQueue] Resuming queue for ${zaloId}`);
                this.startForAccount(zaloId);
            }
        }
        catch (err) {
            Logger_1.default.warn(`[CRMQueue] resumeActiveCampaigns: ${err.message}`);
        }
    }
    refillTokens(zaloId) {
        const now = Date.now();
        const lastRefill = this.lastRefillAt.get(zaloId) || now;
        const elapsed = now - lastRefill;
        const tokensToAdd = Math.floor(elapsed / this.REFILL_INTERVAL_MS);
        if (tokensToAdd > 0) {
            const current = this.tokens.get(zaloId) ?? 0;
            this.tokens.set(zaloId, Math.min(this.MAX_TOKENS, current + tokensToAdd));
            this.lastRefillAt.set(zaloId, lastRefill + tokensToAdd * this.REFILL_INTERVAL_MS);
        }
    }
    async process(zaloId) {
        if (this.isProcessing.get(zaloId))
            return;
        // Refill tokens
        this.refillTokens(zaloId);
        const tokens = this.tokens.get(zaloId) ?? 0;
        if (tokens <= 0) {
            Logger_1.default.log(`[CRMQueue] ${zaloId}: No tokens left, waiting for refill`);
            this.broadcastStatus(zaloId, 'rate_limited');
            return;
        }
        const db = DatabaseService_1.default.getInstance();
        const item = db.getNextPendingCampaignContact(zaloId);
        if (!item) {
            this.checkAndStopIfIdle(zaloId);
            return;
        }
        // Check delay (campaign.delay_seconds + jitter ±10s)
        const delayMs = Math.max(this.MIN_DELAY_MS, (item.delay_seconds || 60) * 1000);
        const jitter = (Math.random() - 0.5) * 20000; // ±10s
        const lastSent = this.lastSentAt.get(zaloId) || 0;
        if (Date.now() - lastSent < delayMs + jitter)
            return;
        // Get connection
        const conn = ConnectionManager_1.default.getConnection(zaloId);
        if (!conn?.api) {
            Logger_1.default.warn(`[CRMQueue] No connection for ${zaloId}, skipping`);
            return;
        }
        this.isProcessing.set(zaloId, true);
        db.updateCampaignContactStatus(item.id, 'sending');
        // Substitute template variables in a message string
        const substitute = (tpl) => (tpl || '')
            .replace(/\{name\}/g, item.display_name || item.contact_id)
            .replace(/\{userId\}/g, item.contact_id);
        const campaignType = item.campaign_type || 'message';
        const isGroup = item.contact_type === 'group';
        const message = substitute(item.template_message || '');
        const friendMsg = substitute(item.friend_request_message || '') || message || 'Xin chào!';
        // Parse mixed_config for new-style mixed campaigns
        let mixedConfig = {};
        try {
            mixedConfig = JSON.parse(item.mixed_config || '{}');
        }
        catch { }
        const mixedActions = mixedConfig.actions || [];
        const mixedGroupIds = mixedConfig.group_ids || [];
        // Common log base fields
        const logBase = {
            owner_zalo_id: zaloId,
            contact_id: item.contact_id,
            display_name: item.display_name || '',
            phone: item.phone || '',
            contact_type: isGroup ? 'group' : 'user',
            campaign_id: item.campaign_id,
            sent_at: Date.now(),
        };
        try {
            if (isGroup) {
                // ── Gửi vào nhóm — luôn dùng sendMessage với threadType = 1 ──────
                const groupMsg = message || friendMsg;
                const req = { type: 'sendMessage', msg: groupMsg, threadId: item.contact_id, threadType: 1 };
                const resp = await conn.api.sendMessage({ msg: groupMsg }, item.contact_id, 1);
                db.updateCampaignContactStatus(item.id, 'sent');
                db.saveSendLog({ ...logBase, message: `[Nhóm] ${groupMsg}`, status: 'sent', send_type: 'message',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
            }
            else if (campaignType === 'mixed' && mixedActions.length > 0) {
                // ── Hỗn hợp (mới): thực thi từng action độc lập ─────────────────
                let anyFailed = false;
                for (const action of mixedActions) {
                    try {
                        if (action === 'message') {
                            const req = { type: 'sendMessage', msg: message, threadId: item.contact_id, threadType: 0 };
                            const resp = await conn.api.sendMessage({ msg: message }, item.contact_id, 0);
                            db.saveSendLog({ ...logBase, message: `[Hỗn hợp/Tin nhắn] ${message}`, status: 'sent', send_type: 'message',
                                data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                            Logger_1.default.log(`[CRMQueue] Mixed/message ✅ → ${item.contact_id}`);
                        }
                        else if (action === 'friend_request') {
                            const req = { type: 'sendFriendRequest', msg: friendMsg, userId: item.contact_id };
                            const resp = await conn.api.sendFriendRequest(friendMsg, item.contact_id);
                            db.saveSendLog({ ...logBase, message: `[Hỗn hợp/Kết bạn] ${friendMsg}`, status: 'sent', send_type: 'friend_request',
                                data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                            Logger_1.default.log(`[CRMQueue] Mixed/friend_request ✅ → ${item.contact_id}`);
                        }
                        else if (action === 'invite_to_groups' && mixedGroupIds.length > 0) {
                            const req = { type: 'inviteUserToGroups', userId: item.contact_id, groupIds: mixedGroupIds };
                            const resp = await conn.api.inviteUserToGroups(item.contact_id, mixedGroupIds);
                            // Log each group result separately if response contains per-group info
                            const inviteLabel = `[Hỗn hợp/Mời nhóm] Mời vào ${mixedGroupIds.length} nhóm: ${mixedGroupIds.join(', ')}`;
                            db.saveSendLog({ ...logBase, message: inviteLabel, status: 'sent', send_type: 'invite_to_group',
                                data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                            Logger_1.default.log(`[CRMQueue] Mixed/invite_to_groups ✅ → ${item.contact_id} into ${mixedGroupIds.length} groups`);
                        }
                    }
                    catch (actionErr) {
                        const errCode = Number(actionErr?.errorCode ?? actionErr?.code ?? -1);
                        const req = { type: action, userId: item.contact_id };
                        db.saveSendLog({ ...logBase,
                            message: `[Hỗn hợp/${action}] Lỗi ${errCode}: ${actionErr.message}`,
                            status: 'failed', error: actionErr.message,
                            data_request: JSON.stringify(req), data_response: '' });
                        Logger_1.default.warn(`[CRMQueue] Mixed/${action} ❌ → ${item.contact_id}: ${actionErr.message}`);
                        anyFailed = true;
                    }
                }
                // Campaign contact is marked sent as long as we attempted (individual failures logged above)
                db.updateCampaignContactStatus(item.id, anyFailed && mixedActions.length === 1 ? 'failed' : 'sent');
            }
            else if (campaignType === 'mixed') {
                // ── Hỗn hợp (cũ / fallback): tin nhắn trước, fallback kết bạn ──
                let req = { type: 'sendMessage', msg: message, threadId: item.contact_id, threadType: 0 };
                let resp;
                let actionLabel = 'message';
                try {
                    resp = await conn.api.sendMessage({ msg: message }, item.contact_id, 0);
                }
                catch (msgErr) {
                    if (isMixedFallbackError(msgErr)) {
                        Logger_1.default.log(`[CRMQueue] Mixed fallback → sendFriendRequest for ${item.contact_id}`);
                        req = { type: 'sendFriendRequest', msg: friendMsg, userId: item.contact_id };
                        resp = await conn.api.sendFriendRequest(friendMsg, item.contact_id);
                        actionLabel = 'friend_request_fallback';
                    }
                    else {
                        throw msgErr;
                    }
                }
                db.updateCampaignContactStatus(item.id, 'sent');
                db.saveSendLog({ ...logBase,
                    message: actionLabel === 'message' ? message : `[Kết bạn dự phòng] ${friendMsg}`,
                    status: 'sent',
                    send_type: actionLabel === 'message' ? 'message' : 'friend_request',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
            }
            else if (campaignType === 'friend_request') {
                // ── Kết bạn only ─────────────────────────────────────────────────
                const req = { type: 'sendFriendRequest', msg: friendMsg, userId: item.contact_id };
                const resp = await conn.api.sendFriendRequest(friendMsg, item.contact_id);
                db.updateCampaignContactStatus(item.id, 'sent');
                db.saveSendLog({ ...logBase, message: `[Kết bạn] ${friendMsg}`, status: 'sent',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
            }
            else if (campaignType === 'invite_to_group') {
                // ── Mời vào nhóm (standalone) ─────────────────────────────────────
                const groupIds = mixedGroupIds; // from mixedConfig.group_ids
                if (groupIds.length === 0)
                    throw new Error('Không có nhóm nào được chỉ định trong chiến dịch');
                const req = { type: 'inviteUserToGroups', userId: item.contact_id, groupIds };
                const resp = await conn.api.inviteUserToGroups(item.contact_id, groupIds);
                db.updateCampaignContactStatus(item.id, 'sent');
                db.saveSendLog({ ...logBase,
                    message: `[Mời nhóm] Mời vào ${groupIds.length} nhóm: ${groupIds.join(', ')}`,
                    status: 'sent', send_type: 'invite_to_group',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                Logger_1.default.log(`[CRMQueue] Invite ✅ → ${item.contact_id} into ${groupIds.length} groups`);
            }
            else {
                // ── Tin nhắn only (default) ───────────────────────────────────────
                const req = { type: 'sendMessage', msg: message, threadId: item.contact_id, threadType: 0 };
                const resp = await conn.api.sendMessage({ msg: message }, item.contact_id, 0);
                db.updateCampaignContactStatus(item.id, 'sent');
                db.saveSendLog({ ...logBase, message, status: 'sent',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
            }
            // Tiêu thụ 1 token
            this.tokens.set(zaloId, Math.max(0, (this.tokens.get(zaloId) ?? 1) - 1));
            this.lastSentAt.set(zaloId, Date.now());
            db.save();
            Logger_1.default.log(`[CRMQueue] ✅ Sent to ${item.contact_id} (campaign ${item.campaign_id})`);
            this.broadcastProgress(zaloId, item.campaign_id, item.contact_id, 'sent');
            this.checkCampaignCompletion(item.campaign_id, zaloId);
        }
        catch (err) {
            Logger_1.default.error(`[CRMQueue] ❌ Failed to send to ${item.contact_id}: ${err.message}`);
            db.updateCampaignContactStatus(item.id, 'failed', err.message);
            db.saveSendLog({ ...logBase,
                message: item.template_message || '',
                status: 'failed', error: err.message,
                send_type: campaignType === 'friend_request' ? 'friend_request' : campaignType === 'mixed' ? 'mixed' : 'message',
                data_request: JSON.stringify({ type: campaignType, contact_id: item.contact_id }),
                data_response: '' });
            db.save();
            this.broadcastProgress(zaloId, item.campaign_id, item.contact_id, 'failed', err.message);
        }
        finally {
            this.isProcessing.set(zaloId, false);
        }
    }
    checkCampaignCompletion(campaignId, zaloId) {
        try {
            const db = DatabaseService_1.default.getInstance();
            const contacts = db.getCampaignContacts(campaignId);
            const hasPending = contacts.some(c => c.status === 'pending' || c.status === 'sending');
            if (!hasPending) {
                db.updateCRMCampaignStatus(campaignId, 'done');
                db.save();
                Logger_1.default.log(`[CRMQueue] Campaign ${campaignId} completed`);
                EventBroadcaster_1.default.emit('crm:campaignDone', { zaloId, campaignId });
                this.checkAndStopIfIdle(zaloId);
            }
        }
        catch (err) {
            Logger_1.default.warn(`[CRMQueue] checkCampaignCompletion: ${err.message}`);
        }
    }
    broadcastProgress(zaloId, campaignId, contactId, status, error) {
        EventBroadcaster_1.default.emit('crm:queueUpdate', {
            zaloId, campaignId, contactId, status, error,
            tokens: this.tokens.get(zaloId) ?? 0,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
        });
    }
    broadcastStatus(zaloId, type) {
        EventBroadcaster_1.default.emit('crm:queueStatus', {
            zaloId, type,
            tokens: this.tokens.get(zaloId) ?? 0,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
        });
    }
}
exports.default = CRMQueueService;
/**
 * Kiểm tra lỗi gửi tin nhắn có phải do người dùng chặn người lạ không.
 * Nếu đúng → chế độ hỗn hợp sẽ fallback sang gửi lời mời kết bạn.
 */
function isMixedFallbackError(err) {
    const code = Number(err?.errorCode ?? err?.code ?? err?.error_code ?? -1);
    // Zalo error codes for "can only receive from friends" or "blocked"
    if ([4, 9, 214, 216, 576, 579].includes(code))
        return true;
    const msg = String(err?.message || '').toLowerCase();
    return (msg.includes('block') ||
        msg.includes('chặn') ||
        msg.includes('bạn bè') ||
        msg.includes('không thể gửi') ||
        msg.includes('không hợp lệ') ||
        msg.includes('stranger') ||
        msg.includes('not friend') ||
        msg.includes('permission'));
}
//# sourceMappingURL=CRMQueueService.js.map