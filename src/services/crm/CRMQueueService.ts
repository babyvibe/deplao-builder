import DatabaseService from '../database/DatabaseService';
import ConnectionManager from '../../utils/connection/ConnectionManager';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';
import { parseMarkup } from './message-markup';
import { sendCampaignBlock } from './campaignBlockSender';
import { DEFAULT_CAMPAIGN_SEND_OPTIONS, readCampaignSendOptions, type CampaignSendOptions } from '../../shared/crm/campaignSendPlan';
import { CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, effectiveContactDelayRange } from '../../shared/crm/campaignDelay';
import { summarizeMixedOutcome, type MixedActionOutcome } from '../../shared/crm/campaignOutcome';
import { automationsPausedAfterRestore } from '../cloudflare/restoreGate';

/**
 * CRMQueueService - chạy trong main process
 * Token bucket per account: max 60 tin/giờ, refill 1 token mỗi 60s
 * Dispatcher loop: kiểm tra mỗi 5s, nếu đủ delay → gửi 1 tin rồi đợi
 */
class CRMQueueService {
    private static instance: CRMQueueService;
    private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
    private lastSentAt: Map<string, number> = new Map();
    private isProcessing: Map<string, boolean> = new Map();
    // Token bucket: max 60/giờ - refill 1 token mỗi 60s
    private tokens: Map<string, number> = new Map();
    private lastRefillAt: Map<string, number> = new Map();
    // Daily limit tracking: campaignId → paused due to daily limit
    private dailyPausedCampaigns: Map<number, boolean> = new Map();

    public readonly MAX_TOKENS = 60;
    private readonly REFILL_INTERVAL_MS = 60 * 1000;  // 1 phút / token → 60/giờ
    private readonly CHECK_INTERVAL_MS = 5000;          // kiểm tra mỗi 5s
    private readonly PHONE_RESOLVE_TIMEOUT_MS = 15_000; // timeout resolve phone → tránh treo vô hạn

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

    public getStatus(zaloId: string): { running: boolean; tokens: number; maxTokens: number; lastSentAt: number; dailyPaused: boolean } {
        const isDailyPaused = Array.from(this.dailyPausedCampaigns.values()).some(v => v);
        return {
            running: this.timers.has(zaloId),
            tokens: this.tokens.get(zaloId) ?? this.MAX_TOKENS,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
            dailyPaused: isDailyPaused,
        };
    }

    /** Khởi động lại tất cả campaigns đang active (sau khi app restart) */
    public resumeActiveCampaigns(): void {
        // Vừa khôi phục DB từ Cloudflare: chờ người dùng xác nhận máy cũ đã tắt rồi mới chạy tiếp (tránh gửi hai lần).
        if (automationsPausedAfterRestore()) {
            Logger.warn('[CRMQueue] resumeActiveCampaigns skipped: automations paused after restore');
            return;
        }
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

        // ── Daily send limit check ──────────────────────────────────────
        const campaignData = db.getCRMCampaign(item.campaign_id);

        // ── Daily start time (tách riêng, không phụ thuộc daily_send_limit) ──
        // Nếu daily_start_time đã qua hôm nay → chạy luôn
        // Nếu chưa đến → đợi
        if (campaignData && campaignData.daily_start_time) {
            const now = new Date();
            const [hh, mm] = campaignData.daily_start_time.split(':').map(Number);
            if (!isNaN(hh) && !isNaN(mm)) {
                const todayStartTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
                if (now < todayStartTime) {
                    Logger.log(`[CRMQueue] Campaign ${item.campaign_id}: before daily start time ${campaignData.daily_start_time}`);
                    this.broadcastStatus(zaloId, 'waiting_for_start_time');
                    return;
                }
            }
        }

        // ── Daily limit (chỉ áp dụng nếu có giới hạn) ───────────────────
        if (campaignData && campaignData.daily_send_limit && campaignData.daily_send_limit > 0) {
            const dailyCount = db.getDailySentCountForCampaign(item.campaign_id);
            if (dailyCount >= campaignData.daily_send_limit) {
                this.dailyPausedCampaigns.set(item.campaign_id, true);
                Logger.log(`[CRMQueue] Campaign ${item.campaign_id} daily limit reached: ${dailyCount}/${campaignData.daily_send_limit}`);
                this.broadcastStatus(zaloId, 'daily_limit_reached');
                return;
            }
            this.dailyPausedCampaigns.delete(item.campaign_id);
        }

        // Check delay: random between delay_min_seconds and delay_max_seconds (range-based), tối thiểu 30 giây
        const itemAny = item as any;
        const rawMin = itemAny.delay_min_seconds ?? Math.max(CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, (item.delay_seconds || 60) - 10);
        const rawMax = itemAny.delay_max_seconds ?? Math.max(rawMin, (item.delay_seconds || 60) + 10);
        const [delayMinSec, delayMaxSec] = effectiveContactDelayRange(rawMin, rawMax);
        const actualDelayMs = (delayMinSec + Math.random() * (delayMaxSec - delayMinSec)) * 1000;
        const lastSent = this.lastSentAt.get(zaloId) || 0;
        if (Date.now() - lastSent < actualDelayMs) return;

        // Get connection
        const conn = ConnectionManager.getConnection(zaloId);
        const account = db.getAccounts().find(a => a.zalo_id === zaloId);
        // Account is authoritative for legacy campaigns created before the
        // channel snapshot migration; new campaigns persist the same value.
        const channel = account?.channel || (campaignData as any)?.channel || 'zalo';
        if (channel === 'zalo' && !conn?.api) {
            Logger.warn(`[CRMQueue] No connection for ${zaloId}, skipping`);
            return;
        }

        // ── Bắt đầu processing ──────────────────────────────────────────────
        // Đặt isProcessing bên ngoài try, nhưng sẽ reset trong finally
        this.isProcessing.set(zaloId, true);

        // Khai báo tất cả vars ở đây để catch block có thể truy cập
        let effectiveContactId = item.contact_id;
        let effectiveDisplayName = item.display_name || '';
        let campaignType: string = 'message';
        let isGroup: boolean = false;
        let friendMsg = '';
        let mixedActions: string[] = [];
        let mixedGroupIds: string[] = [];
        let blocksToSend: any[] = [];
        let sendMode: 'random' | 'all' = 'random';
        let message = '';
        let logBase: any = {};
        let describeBlock: (b: any) => string = () => '';
        let substitute: (tpl: string) => string = (t) => t;
        // Trạng thái thật của liên hệ sau lượt gửi — báo cho màn chiến dịch (trước đây luôn báo 'sent' kể cả khi
        // nhánh nhóm / tin nhắn vừa ghi 'failed' → màn hiện "Đã gửi" tới khi tải lại)
        let outcomeStatus: 'sent' | 'failed' = 'sent';
        let outcomeError: string | undefined;

        try {
            db.updateCampaignContactStatus(item.id!, 'sending');

            // ── Chỉ Zalo đổi SĐT → tài khoản lúc gửi (findUser). Kênh khác: người nhận "phone:…" (thêm từ bản cũ, giờ
            //    TargetSelector ẩn "Theo SĐT") không gửi được → báo lỗi rõ ngay, không tốn lượt gửi
            if (channel !== 'zalo' && item.contact_id.startsWith('phone:')) {
                const phoneError = 'Kênh này không tra được SĐT ra tài khoản — hãy thêm người nhận từ danh bạ';
                db.updateCampaignContactStatus(item.id!, 'failed', phoneError);
                db.save();
                this.broadcastProgress(zaloId, item.campaign_id, item.contact_id, 'failed', phoneError);
                this.checkCampaignCompletion(item.campaign_id, zaloId);
                this.isProcessing.set(zaloId, false);
                return;
            }

            // ── Phone resolution at send time ──────────────────────────────
            if (channel === 'zalo' && item.contact_id.startsWith('phone:')) {
                const phone = item.contact_id.slice(6);
                Logger.log(`[CRMQueue] Resolving phone ${phone} at send time...`);
                const resolved = await this.resolvePhoneContact(phone, conn.api);
                if (!resolved) {
                    Logger.warn(`[CRMQueue] Phone ${phone} not found on Zalo, marking failed`);
                    db.updateCampaignContactStatus(item.id!, 'failed', 'Không tìm thấy SĐT trên Zalo');
                    db.save();
                    this.broadcastProgress(zaloId, item.campaign_id, item.contact_id, 'failed', 'Không tìm thấy SĐT trên Zalo');
                    this.checkCampaignCompletion(item.campaign_id, zaloId);
                    this.isProcessing.set(zaloId, false);
                    return;
                }
                effectiveContactId = resolved.uid;
                effectiveDisplayName = resolved.name;
                try { db.updateCampaignContactId(item.id!, resolved.uid, resolved.name); } catch { /* non-critical */ }
                Logger.log(`[CRMQueue] Phone ${phone} → UID ${resolved.uid} (${resolved.name})`);
            }

            // ── UID resolution at send time ────────────────────────────────
            if (channel === 'zalo' && !effectiveDisplayName && /^\d{5,}$/.test(effectiveContactId)) {
                Logger.log(`[CRMQueue] Resolving UID ${effectiveContactId} via getUserInfo...`);
                try {
                    const infoRes = await (conn.api as any).getUserInfo(effectiveContactId);
                    const profile = infoRes?.response?.changed_profiles?.[effectiveContactId]
                        ?? infoRes?.changed_profiles?.[effectiveContactId];
                    if (profile) effectiveDisplayName = profile.displayName || profile.zaloName || profile.name || '';
                    if (effectiveDisplayName) {
                        try { db.updateCampaignContactId(item.id!, effectiveContactId, effectiveDisplayName); } catch { /* */ }
                        Logger.log(`[CRMQueue] UID ${effectiveContactId} → "${effectiveDisplayName}"`);
                    } else Logger.warn(`[CRMQueue] UID ${effectiveContactId}: getUserInfo returned no name`);
                } catch (uidErr: any) {
                    Logger.warn(`[CRMQueue] UID ${effectiveContactId} getUserInfo failed: ${uidErr.message}`);
                }
            }

            // ── Template preparation ───────────────────────────────────────
            substitute = (tpl: string) =>
                (tpl || '')
                    .replace(/\{name\}/g, effectiveDisplayName || item.contact_id)
                    .replace(/\{userId\}/g, effectiveContactId);

            campaignType = (item as any).campaign_type || 'message';
            isGroup = (item as any).contact_type === 'group';
            friendMsg = substitute((item as any).friend_request_message || '') || substitute(item.template_message || '') || 'Xin chào!';

            let mixedConfig: { actions?: string[]; group_ids?: string[] } = {};
            try { mixedConfig = JSON.parse((item as any).mixed_config || '{}'); } catch {}
            mixedActions = mixedConfig.actions || [];
            mixedGroupIds = mixedConfig.group_ids || [];

            // ── Multi-block template support ───────────────────────────────
            type ContentBlock = { id: string; text: string; images: string[]; tagAll?: boolean; tagAllText?: string };
            const parseContentBlocks = (raw: string): { blocks: ContentBlock[]; mode: 'random' | 'all'; options: CampaignSendOptions } => {
                try {
                    const p = JSON.parse(raw);
                    if (p && Array.isArray(p.blocks)) {
                        return { blocks: p.blocks as ContentBlock[], mode: p.mode === 'all' ? 'all' : 'random', options: readCampaignSendOptions(p) };
                    }
                } catch {}
                return { blocks: [{ id: '', text: raw, images: [] }], mode: 'random', options: DEFAULT_CAMPAIGN_SEND_OPTIONS };
            };

            const { blocks: allBlocks, mode: parsedMode, options: sendOptions } = parseContentBlocks(item.template_message || '');
            sendMode = parsedMode;

            if (sendMode === 'random') {
                const idx = allBlocks.length > 0 ? Math.floor(Math.random() * allBlocks.length) : 0;
                blocksToSend = allBlocks.length > 0 ? [allBlocks[idx]] : [];
            } else {
                blocksToSend = allBlocks;
            }

            // Helper: send one block (text + images) — order / "gộp ảnh + chữ" from the template options
            const sendBlock = (block: ContentBlock, threadId: string, threadType: number): Promise<any[]> =>
                sendCampaignBlock(block, substitute(block.text || ''), {
                    channel,
                    accountId: zaloId,
                    threadId,
                    threadType,
                    zaloApi: conn?.api,
                    options: sendOptions,
                });

            // Legacy single-message string for log display
            const firstBlock = blocksToSend[0];
            const displayText = (raw: string) => {
                const substituted = substitute(raw);
                return channel === 'zalo' ? parseMarkup(substituted).text : substituted;
            };
            const firstBlockText = firstBlock ? displayText(firstBlock.text || '') : '';
            const firstBlockImgCount = firstBlock?.images?.filter(Boolean).length || 0;
            message = firstBlockText.trim()
              ? firstBlockText + (firstBlockImgCount > 0 ? ` + ${firstBlockImgCount} ảnh` : '')
              : firstBlockImgCount > 0
                ? `[${firstBlockImgCount} ảnh]`
                : '(trống)';

            // Helper: describe block content for log (dùng trong catch)
            describeBlock = (block: ContentBlock): string => {
                const txt = displayText(block.text || '').trim();
                const imgCount = (block.images || []).filter(Boolean).length;
                if (txt && imgCount > 0) return `${txt} + ${imgCount} ảnh`;
                if (txt) return txt;
                if (imgCount > 0) return `[${imgCount} ảnh]`;
                return '(trống)';
            };

            // Common log base fields
            logBase = {
                owner_zalo_id: zaloId,
                channel,
                contact_id: effectiveContactId,
                display_name: effectiveDisplayName || '',
                phone: (item as any).phone || '',
                contact_type: isGroup ? 'group' : 'user',
                campaign_id: item.campaign_id,
                sent_at: Date.now(),
            };

            // Helper: send multiple blocks with per-block error catching
            const sendBlocks = async (blocks: ContentBlock[], threadId: string, threadType: number): Promise<{ sent: number; errors: string[]; responses: any[] }> => {
                // Per-contact delay between blocks: use campaign config or fallback 1s
                let perContactDelayMs = 1000;
                if (campaignData) {
                    const pcMin = campaignData.per_contact_delay_min_seconds || 0;
                    const pcMax = campaignData.per_contact_delay_max_seconds || 0;
                    if (pcMin > 0 && pcMax > 0) {
                        perContactDelayMs = (pcMin + Math.random() * (pcMax - pcMin)) * 1000;
                    } else if (pcMin > 0) {
                        perContactDelayMs = pcMin * 1000;
                    }
                }
                let sent = 0;
                const errors: string[] = [];
                const responses: any[] = [];
                for (let bi = 0; bi < blocks.length; bi++) {
                    if (bi > 0) await new Promise(r => setTimeout(r, perContactDelayMs));
                    try {
                        const resps = await sendBlock(blocks[bi], threadId, threadType);
                        responses.push(...resps);
                        sent++;
                    } catch (blockErr: any) {
                        const errMsg = blockErr?.message || String(blockErr);
                        errors.push(errMsg);
                        Logger.error(`[CRMQueue] Block ${bi + 1}/${blocks.length} failed for ${threadId}: ${errMsg}`);
                    }
                }
                return { sent, errors, responses };
            };

            // ── Actual send logic ──────────────────────────────────────────
            if (isGroup) {
                // ── Gửi vào nhóm ─────────────────────────────────────────────────
                const threadType = 1;
                const result = await sendBlocks(blocksToSend, effectiveContactId, threadType);
                const logMsg = sendMode === 'all'
                    ? `[Nhóm] ${result.sent}/${blocksToSend.length} nội dung: ${blocksToSend.map(describeBlock).join(' | ')}`
                    : `[Nhóm] ${message}`;
                outcomeStatus = result.errors.length > 0 ? 'failed' : 'sent';
                outcomeError = result.errors.join('; ') || undefined;
                db.updateCampaignContactStatus(item.id!, outcomeStatus, outcomeError);
                db.saveSendLog({ ...logBase, message: logMsg, status: result.errors.length > 0 ? 'failed' : 'sent',
                    error: result.errors.join('; ') || '', send_type: 'message',
                    data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                    data_response: result.responses.length > 0 ? JSON.stringify(result.responses.length === 1 ? result.responses[0] : result.responses) : '' });

            } else if (campaignType === 'mixed' && mixedActions.length > 0) {
                // ── Hỗn hợp (mới) ────────────────────────────────────────────────
                const outcomes: MixedActionOutcome[] = [];
                for (const action of mixedActions) {
                    try {
                        if (action === 'message') {
                            const threadType = 0;
                            const result = await sendBlocks(blocksToSend, effectiveContactId, threadType);
                            const logMsg = sendMode === 'all'
                                ? `[Hỗn hợp/Tin nhắn] ${result.sent}/${blocksToSend.length} nội dung: ${blocksToSend.map(describeBlock).join(' | ')}`
                                : `[Hỗn hợp/Tin nhắn] ${message}`;
                            db.saveSendLog({ ...logBase, message: logMsg, status: result.errors.length > 0 ? 'failed' : 'sent',
                                error: result.errors.join('; ') || '', send_type: 'message',
                                data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                                data_response: result.responses.length > 0 ? JSON.stringify(result.responses.length === 1 ? result.responses[0] : result.responses) : '' });
                            outcomes.push({ action, ok: result.errors.length === 0, error: result.errors.join('; ') || undefined });
                            Logger.log(`[CRMQueue] Mixed/message ${result.errors.length > 0 ? '❌' : '✅'} → ${effectiveContactId} (${result.sent}/${blocksToSend.length} blocks)`);

                        } else if (action === 'friend_request') {
                            const req = { type: 'sendFriendRequest', msg: friendMsg, userId: effectiveContactId };
                            const resp = await (conn.api as any).sendFriendRequest(friendMsg, effectiveContactId);
                            db.saveSendLog({ ...logBase, message: `[Hỗn hợp/Kết bạn] ${friendMsg}`, status: 'sent', send_type: 'friend_request',
                                data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                            outcomes.push({ action, ok: true });
                            Logger.log(`[CRMQueue] Mixed/friend_request ✅ → ${effectiveContactId}`);

                        } else if (action === 'invite_to_groups' && mixedGroupIds.length > 0) {
                            const req = { type: 'inviteUserToGroups', userId: effectiveContactId, groupIds: mixedGroupIds };
                            const resp = await (conn.api as any).inviteUserToGroups(effectiveContactId, mixedGroupIds);
                            db.saveSendLog({ ...logBase,
                                message: `[Hỗn hợp/Mời nhóm] Mời vào ${mixedGroupIds.length} nhóm: ${mixedGroupIds.join(', ')}`,
                                status: 'sent', send_type: 'invite_to_group',
                                data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                            outcomes.push({ action, ok: true });
                            Logger.log(`[CRMQueue] Mixed/invite_to_groups ✅ → ${effectiveContactId} into ${mixedGroupIds.length} groups`);
                        }
                    } catch (actionErr: any) {
                        const errCode = Number(actionErr?.errorCode ?? actionErr?.code ?? actionErr?.error_code ?? -1);
                        const req = { type: action, userId: effectiveContactId };
                        const errResponse = {
                            error: true,
                            message: actionErr.message,
                            errorCode: errCode !== -1 ? errCode : undefined,
                        };
                        db.saveSendLog({ ...logBase,
                            message: `[Hỗn hợp/${action}] Lỗi: ${actionErr.message}`,
                            status: 'failed', error: actionErr.message,
                            data_request: JSON.stringify(req), data_response: JSON.stringify(errResponse) });
                        Logger.warn(`[CRMQueue] Mixed/${action} ❌ → ${effectiveContactId}: ${actionErr.message}`);
                        outcomes.push({ action, ok: false, error: actionErr.message });
                    }
                }
                // Tất cả hành động lỗi → "Lỗi"; một phần → "Đã gửi" kèm lỗi các hành động hỏng (shared/crm/campaignOutcome)
                const summary = summarizeMixedOutcome(outcomes);
                outcomeStatus = summary.status;
                outcomeError = summary.error;
                db.updateCampaignContactStatus(item.id!, outcomeStatus, outcomeError);

            } else if (campaignType === 'mixed') {
                // ── Hỗn hợp (cũ / fallback) ──────────────────────────────────────
                let actionLabel = 'message';
                let mixedResp: any[] = [];
                try {
                    mixedResp = await sendBlock(blocksToSend[0] ?? { id: '', text: '', images: [] }, effectiveContactId, 0);
                } catch (msgErr: any) {
                    if (isMixedFallbackError(msgErr)) {
                        Logger.log(`[CRMQueue] Mixed fallback → sendFriendRequest for ${effectiveContactId}`);
                        const friendResp = await (conn.api as any).sendFriendRequest(friendMsg, effectiveContactId);
                        mixedResp = [friendResp];
                        actionLabel = 'friend_request_fallback';
                    } else { throw msgErr; }
                }
                db.updateCampaignContactStatus(item.id!, 'sent');
                db.saveSendLog({ ...logBase,
                    message: actionLabel === 'message' ? message : `[Kết bạn dự phòng] ${friendMsg}`,
                    status: 'sent',
                    send_type: actionLabel === 'message' ? 'message' : 'friend_request',
                    data_request: JSON.stringify({ type: actionLabel, contact_id: effectiveContactId }),
                    data_response: mixedResp.length > 0 ? JSON.stringify(mixedResp.length === 1 ? mixedResp[0] : mixedResp) : '' });

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
                    ? `[${result.sent}/${blocksToSend.length} nội dung] ${blocksToSend.map(describeBlock).join(' | ')}`
                    : message;
                outcomeStatus = result.errors.length > 0 ? 'failed' : 'sent';
                outcomeError = result.errors.join('; ') || undefined;
                db.updateCampaignContactStatus(item.id!, outcomeStatus, outcomeError);
                db.saveSendLog({ ...logBase, message: logMsg, status: outcomeStatus,
                    error: result.errors.join('; ') || '',
                    data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                    data_response: result.responses.length > 0 ? JSON.stringify(result.responses.length === 1 ? result.responses[0] : result.responses) : '' });
            }

            // Tiêu thụ 1 token
            this.tokens.set(zaloId, Math.max(0, (this.tokens.get(zaloId) ?? 1) - 1));
            this.lastSentAt.set(zaloId, Date.now());
            db.save();

            Logger.log(`[CRMQueue] ${outcomeStatus === 'failed' ? '❌ Failed' : outcomeError ? '⚠️ Partly sent' : '✅ Sent'} to ${effectiveContactId} (campaign ${item.campaign_id})`);
            this.broadcastProgress(zaloId, item.campaign_id, effectiveContactId, outcomeStatus, outcomeError);
            this.checkCampaignCompletion(item.campaign_id, zaloId);

        } catch (err: any) {
            const errMsg = err?.message || String(err);
            Logger.error(`[CRMQueue] ❌ Failed to send to ${effectiveContactId}: ${errMsg}`);
            // Always save log on failure - use describeBlock for human-readable message
            const fallbackLogMsg = blocksToSend.length > 0
                ? blocksToSend.map(describeBlock).join(' | ')
                : (item.template_message || '(unknown)');
            try {
                db.updateCampaignContactStatus(item.id!, 'failed', errMsg);
                // Capture error response details if available
                const errResponse: any = {
                    error: true,
                    message: errMsg,
                    errorCode: err?.errorCode ?? err?.code ?? err?.error_code ?? undefined,
                };
                db.saveSendLog({ ...logBase,
                    message: `[Lỗi] ${errMsg} - ${fallbackLogMsg}`,
                    status: 'failed', error: errMsg,
                    send_type: campaignType === 'friend_request' ? 'friend_request' : campaignType === 'mixed' ? 'mixed' : 'message',
                    data_request: JSON.stringify({ type: campaignType, contact_id: effectiveContactId }),
                    data_response: JSON.stringify(errResponse) });
                db.save();
            } catch (logErr: any) {
                Logger.error(`[CRMQueue] ❌ Failed to save error log: ${logErr.message}`);
            }
            this.broadcastProgress(zaloId, item.campaign_id, effectiveContactId, 'failed', errMsg);
            this.checkCampaignCompletion(item.campaign_id, zaloId);
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
        const db = DatabaseService.getInstance();
        const dailyCount = db.getDailySentCountForCampaign(campaignId);
        EventBroadcaster.emit('crm:queueUpdate', {
            zaloId, campaignId, contactId, status, error,
            tokens: this.tokens.get(zaloId) ?? 0,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
            dailySentCount: dailyCount,
        });
    }

    private broadcastStatus(zaloId: string, type: string): void {
        const isDailyPaused = type === 'daily_limit_reached' || type === 'waiting_for_start_time';
        EventBroadcaster.emit('crm:queueStatus', {
            zaloId, type,
            tokens: this.tokens.get(zaloId) ?? 0,
            maxTokens: this.MAX_TOKENS,
            lastSentAt: this.lastSentAt.get(zaloId) ?? 0,
            dailyPaused: isDailyPaused,
        });
    }

    /**
     * Resolve a phone number to Zalo UID via API.
     * Called at send time to avoid rate limiting when importing phones.
     * Returns { uid, name } or null if not found.
     */
    private async resolvePhoneContact(phone: string, api: any): Promise<{ uid: string; name: string } | null> {
        // Timeout để tránh API treo vô hạn → queue tê liệt
        /** Helper tạo promise với timeout */
        const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
            Promise.race([
                promise,
                new Promise<T>((_, reject) => setTimeout(() => reject(new Error('API timeout')), ms)),
            ]);
        try {
            const res: any = await withTimeout(api.findUser(phone), this.PHONE_RESOLVE_TIMEOUT_MS);
            const u: any = res?.response ?? res;
            if (!u?.uid) return null;
            let name = u.display_name || u.zalo_name || phone;
            try {
                const infoRes: any = await withTimeout(api.getUserInfo(u.uid), this.PHONE_RESOLVE_TIMEOUT_MS);
                const profile: any = infoRes?.response?.changed_profiles?.[u.uid] ?? infoRes?.changed_profiles?.[u.uid];
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
