import DatabaseService from '../database/DatabaseService';
import ConnectionManager from '../../utils/connection/ConnectionManager';
import FacebookConnectionManager from '../../utils/connection/FacebookConnectionManager';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';
import { parseMarkup } from './message-markup';
import { sendCampaignBlock } from './campaignBlockSender';
import { applyCampaignSuccessLabels } from './campaignLabels';
import {
  genderText,
  genderTextFromProfile,
  recipientPhone,
  resolveCampaignPhone,
  substituteCampaignVars,
  type CampaignVars,
} from '../../shared/crm/campaignVars';
import { DEFAULT_CAMPAIGN_SEND_OPTIONS, readCampaignSendOptions, type CampaignSendOptions } from '../../shared/crm/campaignSendPlan';
import { CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, effectiveContactDelayRange } from '../../shared/crm/campaignDelay';
import { summarizeMixedOutcome, type MixedActionOutcome } from '../../shared/crm/campaignOutcome';
import { campaignAutoResumeAt, campaignAutoStopReason, campaignFlag, shouldAutoStopCampaign } from '../../shared/crm/campaignAutoStop';
import type { CRMCampaign } from '../../models';
import { automationsPausedAfterRestore } from '../cloudflare/restoreGate';
import { tr } from '../../shared/i18n';

/**
 * CRMQueueService - runs in the main process
 * Token bucket per account: max 60 messages/hour, refill 1 token every 60s
 * Dispatcher loop: checks every 5s; if the delay has passed → send 1 message, then wait
 * Auto-stops after N contacts fail in a row (set per campaign, default: never stop): trackFailureStreak; "Mai gửi tiếp" (Resume tomorrow):
 * scheduleAutoResume
 */
class CRMQueueService {
    private static instance: CRMQueueService;
    private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
    private lastSentAt: Map<string, number> = new Map();
    private isProcessing: Map<string, boolean> = new Map();
    // Token bucket: max 60/hour - refill 1 token every 60s
    private tokens: Map<string, number> = new Map();
    private lastRefillAt: Map<string, number> = new Map();
    // Daily limit tracking: campaignId → paused due to daily limit
    private dailyPausedCampaigns: Map<number, boolean> = new Map();
    // Auto-stop "Mai gửi tiếp" (Resume tomorrow): one timer for the campaign that needs to run again soonest (all accounts)
    private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;

    public readonly MAX_TOKENS = 60;
    private readonly REFILL_INTERVAL_MS = 60 * 1000;  // 1 minute / token → 60/hour
    private readonly CHECK_INTERVAL_MS = 5000;          // check every 5s
    private readonly PHONE_RESOLVE_TIMEOUT_MS = 15_000; // timeout for resolving the phone → avoid hanging forever
    private readonly AUTO_RESUME_RECHECK_MS = 60 * 60 * 1000; // machine asleep / clock changed: the wake-up timer re-checks at least once an hour

    public static getInstance(): CRMQueueService {
        if (!CRMQueueService.instance) CRMQueueService.instance = new CRMQueueService();
        return CRMQueueService.instance;
    }

    /** Start the dispatcher for the account */
    public startForAccount(zaloId: string): void {
        if (this.timers.has(zaloId)) return;
        Logger.log(`[CRMQueue] ▶ Starting queue for ${zaloId}`);
        if (!this.tokens.has(zaloId)) {
            this.tokens.set(zaloId, this.MAX_TOKENS);
            this.lastRefillAt.set(zaloId, Date.now());
        } else {
            // The queue ran before → refill now based on the time elapsed
            this.refillTokens(zaloId);
        }
        const timer = setInterval(() => this.process(zaloId), this.CHECK_INTERVAL_MS);
        this.timers.set(zaloId, timer);
    }

    /** Stop the dispatcher for the account */
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

    /** Stop if no campaign is active any more */
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

    /** Restart all active campaigns (after the app restarts) */
    public resumeActiveCampaigns(): void {
        // Just restored the DB from Cloudflare: wait for the user to confirm the old machine is off before running again (avoid sending twice).
        if (automationsPausedAfterRestore()) {
            Logger.warn('[CRMQueue] resumeActiveCampaigns skipped: automations paused after restore');
            return;
        }
        try {
            // "Mai gửi tiếp" (Resume tomorrow): an auto-stopped campaign whose re-run time passed while the app was off → run now; otherwise schedule a timer
            this.resumeDueCampaigns();
            const owners = DatabaseService.getInstance().getActiveCampaignOwners();
            for (const zaloId of owners) {
                Logger.log(`[CRMQueue] Resuming queue for ${zaloId}`);
                this.startForAccount(zaloId);
            }
        } catch (err: any) {
            Logger.warn(`[CRMQueue] resumeActiveCampaigns: ${err.message}`);
        }
    }

    /** Schedule the earliest re-run of the auto-stopped "Mai gửi tiếp" (Resume tomorrow) campaign (called after an auto-stop and when the app opens). */
    private scheduleAutoResume(): void {
        if (this.autoResumeTimer) { clearTimeout(this.autoResumeTimer); this.autoResumeTimer = null; }
        let next = 0;
        try { next = DatabaseService.getInstance().nextCampaignAutoResumeAt(); } catch { return; }
        if (!next) return;
        const wait = Math.min(Math.max(next - Date.now(), 1000), this.AUTO_RESUME_RECHECK_MS);
        this.autoResumeTimer = setTimeout(() => { this.autoResumeTimer = null; this.resumeDueCampaigns(); }, wait);
        // Do not keep the app alive on exit (like the queue timers, which are cleaned up when the app closes)
        (this.autoResumeTimer as any)?.unref?.();
    }

    /** Re-run the auto-stopped "Mai gửi tiếp" (Resume tomorrow) campaign that is due, then schedule the next one. */
    private resumeDueCampaigns(): void {
        // Just restored the DB: wait for the user to confirm (resumeAutomationsAfterRestore calls resumeActiveCampaigns again)
        if (automationsPausedAfterRestore()) return;
        try {
            const db = DatabaseService.getInstance();
            for (const campaign of db.getDueAutoResumeCampaigns(Date.now())) {
                if (!db.resumeAutoStoppedCampaign(campaign.id)) continue;
                db.save();
                Logger.log(`[CRMQueue] ▶ Campaign ${campaign.id} resumed the day after its auto-stop`);
                EventBroadcaster.emit('crm:campaignChanged', { action: 'status', ownerZaloId: campaign.owner_zalo_id, campaignId: campaign.id, status: 'active' });
                this.startForAccount(campaign.owner_zalo_id);
            }
        } catch (err: any) {
            Logger.warn(`[CRMQueue] resumeDueCampaigns: ${err.message}`);
        }
        this.scheduleAutoResume();
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

        // ── Daily start time (separate, does not depend on daily_send_limit) ──
        // If daily_start_time has already passed today → run now
        // If not yet → wait
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

        // ── Daily limit (applies only if a limit is set) ───────────────────
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

        // Check delay: random between delay_min_seconds and delay_max_seconds (range-based), minimum 30 seconds
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
        // A Facebook owner is not in `accounts` (it lives in `fb_accounts`) → getAccountChannel covers it.
        const channel = account?.channel || db.getAccountChannel(zaloId) || (campaignData as any)?.channel || 'zalo';
        if (channel === 'zalo' && !conn?.api) {
            Logger.warn(`[CRMQueue] No connection for ${zaloId}, skipping`);
            return;
        }
        // Facebook: wait for the account to be connected instead of failing the contact (same as Zalo above).
        // Sends go through FacebookService (E2EE bridge for 1:1, upload + REST for groups).
        if (channel === 'facebook') {
            const fb = FacebookConnectionManager.get(zaloId);
            if (!fb?.isConnected?.()) {
                Logger.warn(`[CRMQueue] Facebook account ${zaloId} is not connected, skipping`);
                return;
            }
        }
        // Message campaigns only on Facebook: a legacy / hand-edited record must not reach the Zalo-only branches
        if (channel === 'facebook' && ((campaignData?.campaign_type || 'message') !== 'message')) {
            const reason = tr('Facebook chỉ hỗ trợ chiến dịch gửi tin nhắn trong CRM');
            db.updateCampaignContactStatus(item.id!, 'failed', reason);
            db.save();
            this.broadcastProgress(zaloId, item.campaign_id, item.contact_id, 'failed', reason);
            this.finishContact(zaloId, item.campaign_id, campaignData, {
                failed: true, error: reason, strangersOnly: false, counted: true,
            });
            return;
        }

        // Auto-stop on errors. "Chỉ tính người lạ" (Count strangers only) (Zalo): Zalo blocks spam by message to strangers, but messaging friends / groups is still allowed
        // → friends and groups do not change the consecutive error streak. Other channels have no friend list → every contact counts.
        const strangersOnly = channel === 'zalo' && campaignFlag(campaignData?.stop_strangers_only) === 1;
        let strangerTarget = (item as any).contact_type !== 'group' && Number((item as any).is_friend) !== 1;
        const outcome = (failed: boolean, error?: string): StreakOutcome => ({
            failed, error, strangersOnly, counted: !strangersOnly || strangerTarget,
        });

        // ── Start processing ──────────────────────────────────────────────
        // Set isProcessing outside the try, but reset it in finally
        this.isProcessing.set(zaloId, true);

        // Declare all vars here so the catch block can access them
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
        // Values of the template variables for this recipient ({name}, {userId}, {gender}, {phone}); filled in before the
        // first substitution so the same closure can be reused for every block / friend request message.
        const templateVars: CampaignVars = { name: effectiveDisplayName || item.contact_id, userId: effectiveContactId, gender: '', phone: '' };
        // Phone the Zalo profile lookup returned while resolving the name (only used when it happened - never an extra call)
        let profilePhone = '';
        let profileGender = '';
        // The real state of the contact after the send round: reported to the campaign screen (it used to always report 'sent', even when
        // the group / message branch had just written 'failed' → the screen shows "Đã gửi" (Sent) until it reloads).
        let outcomeStatus: 'sent' | 'failed' = 'sent';
        let outcomeError: string | undefined;

        try {
            db.updateCampaignContactStatus(item.id!, 'sending');

            // ── Only Zalo maps the phone number to an account at send time (findUser). Other channels: a recipient "phone:…" (added in an older version, now
            //    TargetSelector hides "Theo SĐT" (By phone)) cannot be sent → report a clear error at once, without using a send slot
            if (channel !== 'zalo' && item.contact_id.startsWith('phone:')) {
                const phoneError = tr('Kênh này không tra được SĐT ra tài khoản — hãy thêm người nhận từ danh bạ');
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
                    db.updateCampaignContactStatus(item.id!, 'failed', tr('Không tìm thấy SĐT trên Zalo'));
                    db.save();
                    this.broadcastProgress(zaloId, item.campaign_id, item.contact_id, 'failed', tr('Không tìm thấy SĐT trên Zalo'));
                    // An account that is limited on phone lookups also returns "không tìm thấy" (not found) → counts toward the consecutive error streak (an unknown phone = a stranger)
                    this.finishContact(zaloId, item.campaign_id, campaignData, outcome(true, tr('Không tìm thấy SĐT trên Zalo')));
                    this.isProcessing.set(zaloId, false);
                    return;
                }
                effectiveContactId = resolved.uid;
                effectiveDisplayName = resolved.name;
                try { strangerTarget = !db.checkIsFriend(zaloId, resolved.uid); } catch { /* keep: an unknown phone = a stranger */ }
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
                    // A profile that had to be loaded anyway may carry a phone / gender: reuse it, never call the API for it
                    if (profile) {
                        profilePhone = String(profile.phoneNumber ?? profile.phone ?? '').trim();
                        profileGender = genderTextFromProfile(profile.gender);
                    }
                    if (effectiveDisplayName) {
                        try { db.updateCampaignContactId(item.id!, effectiveContactId, effectiveDisplayName); } catch { /* */ }
                        Logger.log(`[CRMQueue] UID ${effectiveContactId} → "${effectiveDisplayName}"`);
                    } else Logger.warn(`[CRMQueue] UID ${effectiveContactId}: getUserInfo returned no name`);
                } catch (uidErr: any) {
                    Logger.warn(`[CRMQueue] UID ${effectiveContactId} getUserInfo failed: ${uidErr.message}`);
                }
            }

            // ── Template preparation ───────────────────────────────────────
            // {phone}: the number that came with the recipient list (file / "Theo SĐT"), then the CRM contact record,
            // then the profile this send already loaded. {gender}: the CRM record, then the same profile.
            let crmContact: { phone?: string | null; gender?: number | null } | undefined;
            try { crmContact = db.getContactById(zaloId, effectiveContactId) as any; } catch { /* CRM row is optional */ }
            templateVars.name = effectiveDisplayName || item.contact_id;
            templateVars.userId = effectiveContactId;
            templateVars.phone = resolveCampaignPhone({
                filePhone: recipientPhone(item.contact_id, (item as any).phone),
                crmPhone: crmContact?.phone,
                profilePhone,
            });
            templateVars.gender = genderText(crmContact?.gender) || profileGender;
            substitute = (tpl: string) => substituteCampaignVars(tpl || '', templateVars);

            campaignType = (item as any).campaign_type || 'message';
            isGroup = (item as any).contact_type === 'group';
            friendMsg = substitute((item as any).friend_request_message || '') || substitute(item.template_message || '') || tr('Xin chào!');

            let mixedConfig: { actions?: string[]; group_ids?: string[] } = {};
            try { mixedConfig = JSON.parse((item as any).mixed_config || '{}'); } catch {}
            mixedActions = mixedConfig.actions || [];
            mixedGroupIds = mixedConfig.group_ids || [];

            // ── Multi-block template support ───────────────────────────────
            type ContentBlock = { id: string; text: string; images: string[]; videos: string[]; files: string[]; tagAll?: boolean; tagAllText?: string };
            const stringList = (value: unknown): string[] =>
                Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string' && path.length > 0) : [];
            const parseContentBlocks = (raw: string): { blocks: ContentBlock[]; mode: 'random' | 'all'; options: CampaignSendOptions } => {
                try {
                    const p = JSON.parse(raw);
                    if (p && Array.isArray(p.blocks)) {
                        // Older templates have no videos/files: normalize so the sender always sees arrays
                        const blocks = (p.blocks as any[]).map((block) => ({
                            ...block,
                            images: stringList(block?.images),
                            videos: stringList(block?.videos),
                            files: stringList(block?.files),
                        })) as ContentBlock[];
                        return { blocks, mode: p.mode === 'all' ? 'all' : 'random', options: readCampaignSendOptions(p) };
                    }
                } catch {}
                return { blocks: [{ id: '', text: raw, images: [], videos: [], files: [] }], mode: 'random', options: DEFAULT_CAMPAIGN_SEND_OPTIONS };
            };

            const { blocks: allBlocks, mode: parsedMode, options: sendOptions } = parseContentBlocks(item.template_message || '');
            sendMode = parsedMode;

            if (sendMode === 'random') {
                const idx = allBlocks.length > 0 ? Math.floor(Math.random() * allBlocks.length) : 0;
                blocksToSend = allBlocks.length > 0 ? [allBlocks[idx]] : [];
            } else {
                blocksToSend = allBlocks;
            }

            // Helper: send one block (text + images): order / "gộp ảnh + chữ" (merge images + text) from the template options
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
            const attachmentSummary = (block: ContentBlock | undefined): string => {
                if (!block) return '';
                const counts: string[] = [];
                const images = block.images?.filter(Boolean).length || 0;
                const videos = block.videos?.filter(Boolean).length || 0;
                const files = block.files?.filter(Boolean).length || 0;
                if (images > 0) counts.push(tr('{{count}} ảnh', { count: images }));
                if (videos > 0) counts.push(tr('{{count}} video', { count: videos }));
                if (files > 0) counts.push(tr('{{count}} tệp', { count: files }));
                return counts.join(', ');
            };
            const firstBlockText = firstBlock ? displayText(firstBlock.text || '') : '';
            const firstBlockAttachments = attachmentSummary(firstBlock);
            message = firstBlockText.trim()
              ? firstBlockText + (firstBlockAttachments ? ` + ${firstBlockAttachments}` : '')
              : firstBlockAttachments
                ? `[${firstBlockAttachments}]`
                : tr('(trống)');

            // Helper: describe the block content for the log (used in catch)
            describeBlock = (block: ContentBlock): string => {
                const txt = displayText(block.text || '').trim();
                const attachments = attachmentSummary(block);
                if (txt && attachments) return `${txt} + ${attachments}`;
                if (txt) return txt;
                if (attachments) return `[${attachments}]`;
                return tr('(trống)');
            };

            // Common log base fields
            logBase = {
                owner_zalo_id: zaloId,
                channel,
                contact_id: effectiveContactId,
                display_name: effectiveDisplayName || '',
                phone: (item as any).phone || templateVars.phone,
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
                // ── Send to a group ─────────────────────────────────────────────────
                const threadType = 1;
                const result = await sendBlocks(blocksToSend, effectiveContactId, threadType);
                const logMsg = sendMode === 'all'
                    ? tr('[Nhóm] {{sent}}/{{count}} nội dung: {{v1}}', { sent: result.sent, count: blocksToSend.length, v1: blocksToSend.map(describeBlock).join(' | ') })
                    : tr('[Nhóm] {{message}}', { message });
                outcomeStatus = result.errors.length > 0 ? 'failed' : 'sent';
                outcomeError = result.errors.join('; ') || undefined;
                db.updateCampaignContactStatus(item.id!, outcomeStatus, outcomeError);
                db.saveSendLog({ ...logBase, message: logMsg, status: result.errors.length > 0 ? 'failed' : 'sent',
                    error: result.errors.join('; ') || '', send_type: 'message',
                    data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                    data_response: result.responses.length > 0 ? JSON.stringify(result.responses.length === 1 ? result.responses[0] : result.responses) : '' });

            } else if (campaignType === 'mixed' && mixedActions.length > 0) {
                // ── Mixed (new) ────────────────────────────────────────────────
                const outcomes: MixedActionOutcome[] = [];
                for (const action of mixedActions) {
                    try {
                        if (action === 'message') {
                            const threadType = 0;
                            const result = await sendBlocks(blocksToSend, effectiveContactId, threadType);
                            const logMsg = sendMode === 'all'
                                ? tr('[Hỗn hợp/Tin nhắn] {{sent}}/{{count}} nội dung: {{v1}}', { sent: result.sent, count: blocksToSend.length, v1: blocksToSend.map(describeBlock).join(' | ') })
                                : tr('[Hỗn hợp/Tin nhắn] {{message}}', { message });
                            db.saveSendLog({ ...logBase, message: logMsg, status: result.errors.length > 0 ? 'failed' : 'sent',
                                error: result.errors.join('; ') || '', send_type: 'message',
                                data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                                data_response: result.responses.length > 0 ? JSON.stringify(result.responses.length === 1 ? result.responses[0] : result.responses) : '' });
                            outcomes.push({ action, ok: result.errors.length === 0, error: result.errors.join('; ') || undefined });
                            Logger.log(`[CRMQueue] Mixed/message ${result.errors.length > 0 ? '❌' : '✅'} → ${effectiveContactId} (${result.sent}/${blocksToSend.length} blocks)`);

                        } else if (action === 'friend_request') {
                            const req = { type: 'sendFriendRequest', msg: friendMsg, userId: effectiveContactId };
                            const resp = await (conn.api as any).sendFriendRequest(friendMsg, effectiveContactId);
                            db.saveSendLog({ ...logBase, message: tr('[Hỗn hợp/Kết bạn] {{friendMsg}}', { friendMsg }), status: 'sent', send_type: 'friend_request',
                                data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                            outcomes.push({ action, ok: true });
                            Logger.log(`[CRMQueue] Mixed/friend_request ✅ → ${effectiveContactId}`);

                        } else if (action === 'invite_to_groups' && mixedGroupIds.length > 0) {
                            const req = { type: 'inviteUserToGroups', userId: effectiveContactId, groupIds: mixedGroupIds };
                            const resp = await (conn.api as any).inviteUserToGroups(effectiveContactId, mixedGroupIds);
                            db.saveSendLog({ ...logBase,
                                message: tr('[Hỗn hợp/Mời nhóm] Mời vào {{count}} nhóm: {{v1}}', { count: mixedGroupIds.length, v1: mixedGroupIds.join(', ') }),
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
                            message: tr('[Hỗn hợp/{{action}}] Lỗi: {{message}}', { action, message: actionErr.message }),
                            status: 'failed', error: actionErr.message,
                            data_request: JSON.stringify(req), data_response: JSON.stringify(errResponse) });
                        Logger.warn(`[CRMQueue] Mixed/${action} ❌ → ${effectiveContactId}: ${actionErr.message}`);
                        outcomes.push({ action, ok: false, error: actionErr.message });
                    }
                }
                // All action errors → "Lỗi" (Error); partly → "Đã gửi" (Sent) with the errors of the failed actions (shared/crm/campaignOutcome)
                const summary = summarizeMixedOutcome(outcomes);
                outcomeStatus = summary.status;
                outcomeError = summary.error;
                db.updateCampaignContactStatus(item.id!, outcomeStatus, outcomeError);

            } else if (campaignType === 'mixed') {
                // ── Mixed (old / fallback) ──────────────────────────────────────
                let actionLabel = 'message';
                let mixedResp: any[] = [];
                try {
                    mixedResp = await sendBlock(blocksToSend[0] ?? { id: '', text: '', images: [], videos: [], files: [] }, effectiveContactId, 0);
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
                    message: actionLabel === 'message' ? message : tr('[Kết bạn dự phòng] {{friendMsg}}', { friendMsg }),
                    status: 'sent',
                    send_type: actionLabel === 'message' ? 'message' : 'friend_request',
                    data_request: JSON.stringify({ type: actionLabel, contact_id: effectiveContactId }),
                    data_response: mixedResp.length > 0 ? JSON.stringify(mixedResp.length === 1 ? mixedResp[0] : mixedResp) : '' });

            } else if (campaignType === 'friend_request') {
                // ── Friend request only ─────────────────────────────────────────────────
                const req = { type: 'sendFriendRequest', msg: friendMsg, userId: effectiveContactId };
                const resp = await (conn.api as any).sendFriendRequest(friendMsg, effectiveContactId);
                db.updateCampaignContactStatus(item.id!, 'sent');
                db.saveSendLog({ ...logBase, message: tr('[Kết bạn] {{friendMsg}}', { friendMsg }), status: 'sent',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });

            } else if (campaignType === 'invite_to_group') {
                // ── Invite to group (standalone) ─────────────────────────────────────
                const groupIds = mixedGroupIds;
                if (groupIds.length === 0) throw new Error(tr('Không có nhóm nào được chỉ định trong chiến dịch'));
                const req = { type: 'inviteUserToGroups', userId: effectiveContactId, groupIds };
                const resp = await (conn.api as any).inviteUserToGroups(effectiveContactId, groupIds);
                db.updateCampaignContactStatus(item.id!, 'sent');
                db.saveSendLog({ ...logBase,
                    message: tr('[Mời nhóm] Mời vào {{count}} nhóm: {{v1}}', { count: groupIds.length, v1: groupIds.join(', ') }),
                    status: 'sent', send_type: 'invite_to_group',
                    data_request: JSON.stringify(req), data_response: JSON.stringify(resp) });
                Logger.log(`[CRMQueue] Invite ✅ → ${effectiveContactId} into ${groupIds.length} groups`);

            } else {
                // ── Message only (default) ───────────────────────────────────────
                const threadType = 0;
                const result = await sendBlocks(blocksToSend, effectiveContactId, threadType);
                const logMsg = sendMode === 'all'
                    ? tr('[{{sent}}/{{count}} nội dung] {{v1}}', { sent: result.sent, count: blocksToSend.length, v1: blocksToSend.map(describeBlock).join(' | ') })
                    : message;
                outcomeStatus = result.errors.length > 0 ? 'failed' : 'sent';
                outcomeError = result.errors.join('; ') || undefined;
                db.updateCampaignContactStatus(item.id!, outcomeStatus, outcomeError);
                db.saveSendLog({ ...logBase, message: logMsg, status: outcomeStatus,
                    error: result.errors.join('; ') || '',
                    data_request: JSON.stringify({ type: 'sendMessage', threadId: effectiveContactId, threadType, blocks: blocksToSend.length, sent: result.sent }),
                    data_response: result.responses.length > 0 ? JSON.stringify(result.responses.length === 1 ? result.responses[0] : result.responses) : '' });
            }

            // "Gắn nhãn khi gửi thành công": only after a round that really sent (mixed with one failed action still counts
            // as sent). Never throws - a label problem must not turn a delivered message into a failed contact.
            if (outcomeStatus === 'sent') {
                await applyCampaignSuccessLabels({
                    zaloId,
                    channel,
                    threadId: effectiveContactId,
                    threadType: isGroup ? 1 : 0,
                    api: conn?.api,
                    campaign: campaignData,
                });
            }

            // Consume 1 token
            this.tokens.set(zaloId, Math.max(0, (this.tokens.get(zaloId) ?? 1) - 1));
            this.lastSentAt.set(zaloId, Date.now());
            db.save();

            Logger.log(`[CRMQueue] ${outcomeStatus === 'failed' ? '❌ Failed' : outcomeError ? '⚠️ Partly sent' : '✅ Sent'} to ${effectiveContactId} (campaign ${item.campaign_id})`);
            this.broadcastProgress(zaloId, item.campaign_id, effectiveContactId, outcomeStatus, outcomeError);
            // A partial error (mixed: one action succeeded) = the account can still send → does not count toward the consecutive errors
            this.finishContact(zaloId, item.campaign_id, campaignData, outcome(outcomeStatus === 'failed', outcomeError));

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
                    message: tr('[Lỗi] {{errMsg}} - {{fallbackLogMsg}}', { errMsg, fallbackLogMsg }),
                    status: 'failed', error: errMsg,
                    send_type: campaignType === 'friend_request' ? 'friend_request' : campaignType === 'mixed' ? 'mixed' : 'message',
                    data_request: JSON.stringify({ type: campaignType, contact_id: effectiveContactId }),
                    data_response: JSON.stringify(errResponse) });
                db.save();
            } catch (logErr: any) {
                Logger.error(`[CRMQueue] ❌ Failed to save error log: ${logErr.message}`);
            }
            // An error round (friend request / group invite refused…) still counts the spacing + the 60/hour quota, like a sent message: before this
            // next contact ran 5 seconds later → a throttled account got a burst of API calls until the end of the list
            this.tokens.set(zaloId, Math.max(0, (this.tokens.get(zaloId) ?? 1) - 1));
            this.lastSentAt.set(zaloId, Date.now());
            this.broadcastProgress(zaloId, item.campaign_id, effectiveContactId, 'failed', errMsg);
            this.finishContact(zaloId, item.campaign_id, campaignData, outcome(true, errMsg));
        } finally {
            this.isProcessing.set(zaloId, false);
        }
    }

    /** true = the campaign has just finished (no contacts left to send). */
    private checkCampaignCompletion(campaignId: number, zaloId: string): boolean {
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
                return true;
            }
        } catch (err: any) {
            Logger.warn(`[CRMQueue] checkCampaignCompletion: ${err.message}`);
        }
        return false;
    }

    /**
     * After each contact sent / phone lookup: no recipients left → Completed (a finished campaign is not auto-stopped); otherwise record the consecutive
     * error streak; at the threshold, auto-stop.
     */
    private finishContact(zaloId: string, campaignId: number, campaign: CRMCampaign | null, outcome: StreakOutcome): void {
        if (this.checkCampaignCompletion(campaignId, zaloId)) return;
        this.trackFailureStreak(zaloId, campaignId, campaign, outcome);
    }

    /**
     * Consecutive send-error streak of contacts (shared/crm/campaignAutoStop): error +1, a successful send resets it to 0. Reaching the threshold set on the campaign
     * (account blocked / limited / session lost → every contact fails) → Pause the campaign, record the reason + the last error,
     * notify every screen (crm:campaignAutoStopped). A daily limit is not an error: the campaign waits until the next day as before.
     * "Mai gửi tiếp" (Resume tomorrow) → schedule a re-run at the Daily start time the next day (scheduleAutoResume).
     */
    private trackFailureStreak(zaloId: string, campaignId: number, campaign: CRMCampaign | null, outcome: StreakOutcome): void {
        if (!outcome.counted) return; // "Chỉ tính người lạ" (Count strangers only): friends / groups do not change the streak
        try {
            const db = DatabaseService.getInstance();
            const failures = db.recordCampaignOutcome(campaignId, outcome.failed);
            if (!outcome.failed || !shouldAutoStopCampaign(failures, campaign?.stop_after_failures)) return;
            const reason = campaignAutoStopReason(failures, outcome.error, { strangersOnly: outcome.strangersOnly });
            const resumeAt = campaignFlag(campaign?.stop_resume_next_day) ? campaignAutoResumeAt(Date.now(), campaign?.daily_start_time) : 0;
            // Only stop a campaign that is still running (paused by hand / deleted while sending → leave it as is)
            if (!db.autoStopCRMCampaign(campaignId, reason, resumeAt)) return;
            db.save();
            Logger.warn(`[CRMQueue] ⏸ Campaign ${campaignId} auto-stopped: ${reason}${resumeAt ? ` (resumes ${new Date(resumeAt).toISOString()})` : ''}`);
            EventBroadcaster.emit('crm:campaignChanged', { action: 'status', ownerZaloId: zaloId, campaignId, status: 'paused' });
            EventBroadcaster.emit('crm:campaignAutoStopped', {
                zaloId, campaignId, name: campaign?.name || '', failures, reason, strangersOnly: outcome.strangersOnly, resumeAt,
            });
            this.checkAndStopIfIdle(zaloId);
            if (resumeAt) this.scheduleAutoResume();
        } catch (err: any) {
            Logger.warn(`[CRMQueue] trackFailureStreak: ${err.message}`);
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
        // Timeout to avoid an API hanging forever → the queue would freeze
        /** Helper that creates a promise with a timeout */
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

/** Result of one contact for the consecutive error streak. `counted` = false: the streak is not changed ("Chỉ tính người lạ" (Count strangers only), and this is a friend / group). */
type StreakOutcome = { failed: boolean; error?: string; counted: boolean; strangersOnly: boolean };

export default CRMQueueService;

/**
 * Check whether a message send error is because the user blocks strangers.
 * If so → the mixed mode falls back to sending a friend request.
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
