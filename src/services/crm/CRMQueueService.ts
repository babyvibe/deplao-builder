import DatabaseService from '../database/DatabaseService';
import ConnectionManager from '../../utils/ConnectionManager';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

/**
 * CRMQueueService — chạy trong main process
 * Token bucket per account: max 60 tin/giờ, refill 1 token mỗi 60s
 * Dispatcher loop: kiểm tra mỗi 5s, nếu đủ delay → gửi 1 tin rồi đợi
 */
class CRMQueueService {
    private static instance: CRMQueueService;
    private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
    private lastSentAt: Map<string, number> = new Map();
    private isProcessing: Map<string, boolean> = new Map();
    // Token bucket: max 60/giờ — refill 1 token mỗi 60s
    private tokens: Map<string, number> = new Map();
    private lastRefillAt: Map<string, number> = new Map();

    public readonly MAX_TOKENS = 60;
    private readonly REFILL_INTERVAL_MS = 60 * 1000;  // 1 phút / token → 60/giờ
    private readonly CHECK_INTERVAL_MS = 5000;          // kiểm tra mỗi 5s
    private readonly MIN_DELAY_MS = 30 * 1000;          // tối thiểu 30s

    public static getInstance(): CRMQueueService {
        if (!CRMQueueService.instance) CRMQueueService.instance = new CRMQueueService();
        return CRMQueueService.instance;
    }

    /** Bắt đầu dispatcher cho account */
    public startForAccount(zaloId: string): void {
        if (this.timers.has(zaloId)) return;
        Logger.log(`[CRMQueue] ▶ Starting queue for ${zaloId}`);
        if (!this.tokens.has(zaloId)) {
            this.tokens.set(zaloId, this.MAX_TOKENS);
            this.lastRefillAt.set(zaloId, Date.now());
        } else {
            // Queue đã từng chạy trước đó → refill ngay dựa trên thời gian đã qua
            this.refillTokens(zaloId);
        }
        const timer = setInterval(() => this.process(zaloId), this.CHECK_INTERVAL_MS);
        this.timers.set(zaloId, timer);
    }

    /** Dừng dispatcher cho account */
    public stopForAccount(zaloId: string): void {
        const timer = this.timers.get(zaloId);
        if (timer) { clearInterval(timer); this.timers.delete(zaloId); }
        // Clean up satellite maps to prevent unbounded memory growth
        this.lastSentAt.delete(zaloId);
        this.isProcessing.delete(zaloId);
        this.tokens.delete(zaloId);
        this.lastRefillAt.delete(zaloId);
        Logger.log(`[CRMQueue] ⏹ Stopped queue for ${zaloId}`);
        // Notify renderer so the status bar disappears
        EventBroadcaster.emit('crm:queueStatus', {
            zaloId,
            type: 'stopped',
            running: false,
            tokens: this.tokens.get(zaloId) ?? this.MAX_TOKENS,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
        });
    }

    /** Dừng nếu không còn campaign active */
    public checkAndStopIfIdle(zaloId: string): void {
        const hasActive = DatabaseService.getInstance().hasActiveCampaigns(zaloId);
        if (!hasActive) this.stopForAccount(zaloId);
    }

    public getStatus(zaloId: string): { running: boolean; tokens: number; maxTokens: number; lastSentAt: number } {
        return {
            running: this.timers.has(zaloId),
            tokens: this.tokens.get(zaloId) ?? this.MAX_TOKENS,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
        };
    }

    /** Khởi động lại tất cả campaigns đang active (sau khi app restart) */
    public resumeActiveCampaigns(): void {
        try {
            const owners = DatabaseService.getInstance().getActiveCampaignOwners();
            for (const zaloId of owners) {
                Logger.log(`[CRMQueue] Resuming queue for ${zaloId}`);
                this.startForAccount(zaloId);
            }
        } catch (err: any) {
            Logger.warn(`[CRMQueue] resumeActiveCampaigns: ${err.message}`);
        }
    }

    private refillTokens(zaloId: string): void {
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

    private async process(zaloId: string): Promise<void> {
        if (this.isProcessing.get(zaloId)) return;


        // Refill tokens
        this.refillTokens(zaloId);

        const tokens = this.tokens.get(zaloId) ?? 0;
        if (tokens <= 0) {
            Logger.log(`[CRMQueue] ${zaloId}: No tokens left, waiting for refill`);
            this.broadcastStatus(zaloId, 'rate_limited');
            return;
        }

        const db = DatabaseService.getInstance();
        const item = db.getNextPendingCampaignContact(zaloId);
        if (!item) {
            this.checkAndStopIfIdle(zaloId);
            return;
        }

        // Check delay (campaign.delay_seconds + jitter ±10s)
        const delayMs = Math.max(this.MIN_DELAY_MS, (item.delay_seconds || 60) * 1000);
        const jitter = (Math.random() - 0.5) * 20000; // ±10s
        const lastSent = this.lastSentAt.get(zaloId) || 0;
        if (Date.now() - lastSent < delayMs + jitter) return;

        // Get connection
        const conn = ConnectionManager.getConnection(zaloId);
        if (!conn?.api) {
            Logger.warn(`[CRMQueue] No connection for ${zaloId}, skipping`);
            return;
        }

        this.isProcessing.set(zaloId, true);
        db.updateCampaignContactStatus(item.id!, 'sending');

        // ── Phone resolution at send time ────────────────────────────────────
        // If contact_id is a phone placeholder (from by_phone import), resolve now
        let effectiveContactId = item.contact_id;
        let effectiveDisplayName = item.display_name || '';
        if (item.contact_id.startsWith('phone:')) {
            const phone = item.contact_id.slice(6); // strip "phone:" prefix
            Logger.log(`[CRMQueue] Resolving phone ${phone} at send time...`);
            const resolved = await this.resolvePhoneContact(phone, conn.api);
            if (!resolved) {
                Logger.warn(`[CRMQueue] Phone ${phone} not found on Zalo, marking failed`);
                db.updateCampaignContactStatus(item.id!, 'failed', 'Không tìm thấy SĐT trên Zalo');
                db.save();
                this.broadcastProgress(zaloId, item.campaign_id, item.contact_id, 'failed', 'Không tìm thấy SĐT trên Zalo');
                this.isProcessing.set(zaloId, false);
                return;
            }
            effectiveContactId = resolved.uid;
            effectiveDisplayName = resolved.name;
            // Update the DB record so we don't resolve again on retry
            try {
                db.updateCampaignContactId(item.id!, resolved.uid, resolved.name);
            } catch { /* non-critical */ }
            Logger.log(`[CRMQueue] Phone ${phone} → UID ${resolved.uid} (${resolved.name})`);
        }

        // Substitute template variables in a message string
        const substitute = (tpl: string) =>
            (tpl || '')
                .replace(/\{name\}/g, effectiveDisplayName || item.contact_id)
                .replace(/\{userId\}/g, effectiveContactId);

        const campaignType: string = (item as any).campaign_type || 'message';
        const isGroup: boolean = (item as any).contact_type === 'group';
        const friendMsg = substitute((item as any).friend_request_message || '') || substitute(item.template_message || '') || 'Xin chào!';

        // Parse mixed_config for new-style mixed campaigns
        let mixedConfig: { actions?: string[]; group_ids?: string[] } = {};
        try { mixedConfig = JSON.parse((item as any).mixed_config || '{}'); } catch {}
        const mixedActions: string[] = mixedConfig.actions || [];
        const mixedGroupIds: string[] = mixedConfig.group_ids || [];

        // ── Multi-block template support ──────────────────────────────────────
        // template_message may be JSON { mode, blocks } or legacy plain string
        type ContentBlock = { id: string; text: string; images: string[] };

        const parseContentBlocks = (raw: string): { blocks: ContentBlock[]; mode: 'random' | 'all' } => {
            try {
                const p = JSON.parse(raw);
                if (p && Array.isArray(p.blocks)) return { blocks: p.blocks as ContentBlock[], mode: p.mode === 'all' ? 'all' : 'random' };
            } catch {}
            return { blocks: [{ id: '', text: raw, images: [] }], mode: 'random' };
        };

        const { blocks: allBlocks, mode: sendMode } = parseContentBlocks(item.template_message || '');

        // Select which blocks to send
        let blocksToSend: ContentBlock[];
        if (sendMode === 'random') {
            const idx = allBlocks.length > 0 ? Math.floor(Math.random() * allBlocks.length) : 0;
            blocksToSend = allBlocks.length > 0 ? [allBlocks[idx]] : [];
        } else {
            blocksToSend = allBlocks;
        }

        // Helper: send one block (text + images) to a target
        const sendBlock = async (block: ContentBlock, threadId: string, threadType: number): Promise<void> => {
            const text = substitute(block.text || '');
            if (text.trim()) {
                await (conn.api as any).sendMessage({ msg: text }, threadId, threadType);
            }
            const imgs = (block.images || []).filter(Boolean);
            if (imgs.length === 1) {
                await new Promise(r => setTimeout(r, 500));
                await (conn.api as any).sendImage(imgs[0], threadId, threadType);
            } else if (imgs.length > 1) {
                // Batch send all images in one call
                await new Promise(r => setTimeout(r, 500));
                await (conn.api as any).sendImages(imgs, threadId, threadType);
            }
        };

        // Legacy single-message string for log display
        const message = blocksToSend.length > 0 ? substitute(blocksToSend[0].text || '') : '';

        // Common log base fields
        const logBase = {
            owner_zalo_id: zaloId,
            contact_id: effectiveContactId,
            display_name: effectiveDisplayName || '',
            phone: (item as any).phone || '',
            contact_type: isGroup ? 'group' : 'user',
            campaign_id: item.campaign_id,
            sent_at: Date.now(),
        };

        // Helper: send multiple blocks with per-block error catching and 1s delay
        const sendBlocks = async (blocks: ContentBlock[], threadId: string, threadType: number): Promise<{ sent: number; errors: string[] }> => {
            let sent = 0;
            const errors: string[] = [];
            for (let bi = 0; bi < blocks.length; bi++) {
                if (bi > 0) await new Promise(r => setTimeout(r, 1000));
                try {
                    await sendBlock(blocks[bi], threadId, threadType);
                    sent++;
                } catch (blockErr: any) {
                    errors.push(blockErr.message || String(blockErr));
                    Logger.warn(`[CRMQueue] Block ${bi + 1}/${blocks.length} failed for ${threadId}: ${blockErr.message}`);
                }
            }
            return { sent, errors };
        };

        try {
            if (isGroup) {
                // ── Gửi vào nhóm ─────────────────────────────────────────────────
                const threadType = 1;
                const result = await sendBlocks(blocksToSend, effectiveContactId, threadType);
                const logMsg = `[Nhóm] ${sendMode === 'all' ? `${result.sent}/${blocksToSend.length} nội dung` : message}`;
                db.updateCampaignContactStatus(item.id!, result.errors.length > 0 ? 'failed' : 'sent', result.errors.join('; ') || undefined);
                db.saveSendLog({ ...logBase, message: logMsg, status: result.errors.length > 0 ? 'failed' : 'sent', send_type: 'message',
                    data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                    data_response: '' });

            } else if (campaignType === 'mixed' && mixedActions.length > 0) {
                // ── Hỗn hợp (mới) ────────────────────────────────────────────────
                let anyFailed = false;
                for (const action of mixedActions) {
                    try {
                        if (action === 'message') {
                            const threadType = 0;
                            const result = await sendBlocks(blocksToSend, effectiveContactId, threadType);
                            const logMsg = sendMode === 'all'
                                ? `[Hỗn hợp/Tin nhắn] ${result.sent}/${blocksToSend.length} nội dung gửi lần lượt`
                                : `[Hỗn hợp/Tin nhắn] ${message}`;
                            db.saveSendLog({ ...logBase, message: logMsg, status: result.errors.length > 0 ? 'failed' : 'sent', send_type: 'message',
                                data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                                data_response: '' });
                            if (result.errors.length > 0) anyFailed = true;
                            Logger.log(`[CRMQueue] Mixed/message ✅ → ${effectiveContactId} (${result.sent}/${blocksToSend.length} blocks)`);

                        } else if (action === 'friend_request') {
                            const req = { type: 'sendFriendRequest', msg: friendMsg, userId: effectiveContactId };
                            const resp = await (conn.api as any).sendFriendRequest(friendMsg, effectiveContactId);
                            db.saveSendLog({ ...logBase, message: `[Hỗn hợp/Kết bạn] ${friendMsg}`, status: 'sent', send_type: 'friend_request',
                                data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                            Logger.log(`[CRMQueue] Mixed/friend_request ✅ → ${effectiveContactId}`);

                        } else if (action === 'invite_to_groups' && mixedGroupIds.length > 0) {
                            const req = { type: 'inviteUserToGroups', userId: effectiveContactId, groupIds: mixedGroupIds };
                            const resp = await (conn.api as any).inviteUserToGroups(effectiveContactId, mixedGroupIds);
                            db.saveSendLog({ ...logBase,
                                message: `[Hỗn hợp/Mời nhóm] Mời vào ${mixedGroupIds.length} nhóm: ${mixedGroupIds.join(', ')}`,
                                status: 'sent', send_type: 'invite_to_group',
                                data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                            Logger.log(`[CRMQueue] Mixed/invite_to_groups ✅ → ${effectiveContactId} into ${mixedGroupIds.length} groups`);
                        }
                    } catch (actionErr: any) {
                        const errCode = Number(actionErr?.errorCode ?? actionErr?.code ?? -1);
                        const req = { type: action, userId: effectiveContactId };
                        db.saveSendLog({ ...logBase,
                            message: `[Hỗn hợp/${action}] Lỗi ${errCode}: ${actionErr.message}`,
                            status: 'failed', error: actionErr.message,
                            data_request: JSON.stringify(req), data_response: '' });
                        Logger.warn(`[CRMQueue] Mixed/${action} ❌ → ${effectiveContactId}: ${actionErr.message}`);
                        anyFailed = true;
                    }
                }
                db.updateCampaignContactStatus(item.id!, anyFailed && mixedActions.length === 1 ? 'failed' : 'sent');

            } else if (campaignType === 'mixed') {
                // ── Hỗn hợp (cũ / fallback) ──────────────────────────────────────
                let actionLabel = 'message';
                try {
                    await sendBlock(blocksToSend[0] ?? { id: '', text: '', images: [] }, effectiveContactId, 0);
                } catch (msgErr: any) {
                    if (isMixedFallbackError(msgErr)) {
                        Logger.log(`[CRMQueue] Mixed fallback → sendFriendRequest for ${effectiveContactId}`);
                        await (conn.api as any).sendFriendRequest(friendMsg, effectiveContactId);
                        actionLabel = 'friend_request_fallback';
                    } else { throw msgErr; }
                }
                db.updateCampaignContactStatus(item.id!, 'sent');
                db.saveSendLog({ ...logBase,
                    message: actionLabel === 'message' ? message : `[Kết bạn dự phòng] ${friendMsg}`,
                    status: 'sent',
                    send_type: actionLabel === 'message' ? 'message' : 'friend_request',
                    data_request: JSON.stringify({ type: actionLabel, contact_id: effectiveContactId }),
                    data_response: '' });

            } else if (campaignType === 'friend_request') {
                // ── Kết bạn only ─────────────────────────────────────────────────
                const req = { type: 'sendFriendRequest', msg: friendMsg, userId: effectiveContactId };
                const resp = await (conn.api as any).sendFriendRequest(friendMsg, effectiveContactId);
                db.updateCampaignContactStatus(item.id!, 'sent');
                db.saveSendLog({ ...logBase, message: `[Kết bạn] ${friendMsg}`, status: 'sent',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });

            } else if (campaignType === 'invite_to_group') {
                // ── Mời vào nhóm (standalone) ─────────────────────────────────────
                const groupIds = mixedGroupIds;
                if (groupIds.length === 0) throw new Error('Không có nhóm nào được chỉ định trong chiến dịch');
                const req = { type: 'inviteUserToGroups', userId: effectiveContactId, groupIds };
                const resp = await (conn.api as any).inviteUserToGroups(effectiveContactId, groupIds);
                db.updateCampaignContactStatus(item.id!, 'sent');
                db.saveSendLog({ ...logBase,
                    message: `[Mời nhóm] Mời vào ${groupIds.length} nhóm: ${groupIds.join(', ')}`,
                    status: 'sent', send_type: 'invite_to_group',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                Logger.log(`[CRMQueue] Invite ✅ → ${effectiveContactId} into ${groupIds.length} groups`);

            } else {
                // ── Tin nhắn only (default) ───────────────────────────────────────
                const threadType = 0;
                const result = await sendBlocks(blocksToSend, effectiveContactId, threadType);
                const logMsg = sendMode === 'all'
                    ? `[${result.sent}/${blocksToSend.length} nội dung gửi lần lượt] ${message}`
                    : message;
                db.updateCampaignContactStatus(item.id!, result.errors.length > 0 ? 'failed' : 'sent', result.errors.join('; ') || undefined);
                db.saveSendLog({ ...logBase, message: logMsg, status: result.errors.length > 0 ? 'failed' : 'sent',
                    data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                    data_response: '' });
            }

            // Tiêu thụ 1 token
            this.tokens.set(zaloId, Math.max(0, (this.tokens.get(zaloId) ?? 1) - 1));
            this.lastSentAt.set(zaloId, Date.now());
            db.save();

            Logger.log(`[CRMQueue] ✅ Sent to ${effectiveContactId} (campaign ${item.campaign_id})`);
            this.broadcastProgress(zaloId, item.campaign_id, effectiveContactId, 'sent');
            this.checkCampaignCompletion(item.campaign_id, zaloId);

        } catch (err: any) {
            Logger.error(`[CRMQueue] ❌ Failed to send to ${effectiveContactId}: ${err.message}`);
            db.updateCampaignContactStatus(item.id!, 'failed', err.message);
            db.saveSendLog({ ...logBase,
                message: item.template_message || '',
                status: 'failed', error: err.message,
                send_type: campaignType === 'friend_request' ? 'friend_request' : campaignType === 'mixed' ? 'mixed' : 'message',
                data_request: JSON.stringify({ type: campaignType, contact_id: effectiveContactId }),
                data_response: '' });
            db.save();
            this.broadcastProgress(zaloId, item.campaign_id, effectiveContactId, 'failed', err.message);
        } finally {
            this.isProcessing.set(zaloId, false);
        }
    }

    private checkCampaignCompletion(campaignId: number, zaloId: string): void {
        try {
            const db = DatabaseService.getInstance();
            const contacts = db.getCampaignContacts(campaignId);
            const hasPending = contacts.some(c => c.status === 'pending' || c.status === 'sending');
            if (!hasPending) {
                db.updateCRMCampaignStatus(campaignId, 'done');
                db.save();
                Logger.log(`[CRMQueue] Campaign ${campaignId} completed`);
                EventBroadcaster.emit('crm:campaignDone', { zaloId, campaignId });
                this.checkAndStopIfIdle(zaloId);
            }
        } catch (err: any) {
            Logger.warn(`[CRMQueue] checkCampaignCompletion: ${err.message}`);
        }
    }

    private broadcastProgress(zaloId: string, campaignId: number, contactId: string, status: string, error?: string): void {
        EventBroadcaster.emit('crm:queueUpdate', {
            zaloId, campaignId, contactId, status, error,
            tokens: this.tokens.get(zaloId) ?? 0,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
        });
    }

    private broadcastStatus(zaloId: string, type: string): void {
        EventBroadcaster.emit('crm:queueStatus', {
            zaloId, type,
            tokens: this.tokens.get(zaloId) ?? 0,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
        });
    }

    /**
     * Resolve a phone number to Zalo UID via API.
     * Called at send time to avoid rate limiting when importing phones.
     * Returns { uid, name } or null if not found.
     */
    private async resolvePhoneContact(phone: string, api: any): Promise<{ uid: string; name: string } | null> {
        try {
            const res = await api.findUser(phone);
            const u = res?.response ?? res;
            if (!u?.uid) return null;
            let name = u.display_name || u.zalo_name || phone;
            try {
                const infoRes = await api.getUserInfo(u.uid);
                const profile = infoRes?.response?.changed_profiles?.[u.uid] ?? infoRes?.changed_profiles?.[u.uid];
                if (profile) {
                    name = profile.displayName || profile.zaloName || profile.name || name;
                }
            } catch { /* getUserInfo failure is non-fatal */ }
            return { uid: String(u.uid), name };
        } catch {
            return null;
        }
    }
}

export default CRMQueueService;

/**
 * Kiểm tra lỗi gửi tin nhắn có phải do người dùng chặn người lạ không.
 * Nếu đúng → chế độ hỗn hợp sẽ fallback sang gửi lời mời kết bạn.
 */
function isMixedFallbackError(err: any): boolean {
    const code = Number(err?.errorCode ?? err?.code ?? err?.error_code ?? -1);
    // Zalo error codes for "can only receive from friends" or "blocked"
    if ([4, 9, 214, 216, 576, 579].includes(code)) return true;
    const msg = String(err?.message || '').toLowerCase();
    return (
        msg.includes('block') ||
        msg.includes('chặn') ||
        msg.includes('bạn bè') ||
        msg.includes('không thể gửi') ||
        msg.includes('không hợp lệ') ||
        msg.includes('stranger') ||
        msg.includes('not friend') ||
        msg.includes('permission')
    );
}

