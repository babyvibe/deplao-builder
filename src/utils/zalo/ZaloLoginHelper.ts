import { API, CloseReason, Credentials, LoginQRCallbackEventType, Zalo } from "zca-js";
import ConnectionManager from "../connection/ConnectionManager";
import Logger from "../Logger";
import EventBroadcaster, { registerGroupCacheInvalidator } from "../../services/event/EventBroadcaster";
import DatabaseService from "../../services/database/DatabaseService";
import MobileSyncService from "../../services/zalo/mobileSync/MobileSyncService";
import { attachZaloReadElsewhere } from "../../services/zalo/zaloReadElsewhere";
import { recordZaloReceipt } from "../../services/receipts/peerReceipts";
import * as fs from "fs";
import { imageSize } from "image-size";
import { extractUserProfile } from "./profileUtils";
import { createProxyAgent } from "../connection/ProxyHelper";
import { applyZaloBusinessFlag, refreshZaloBusinessFlag } from "./zaloBusinessFlag";
import { whenStartupSettled } from "../startup/startupSettle";
import { refreshZaloAutoDelete } from "../../services/zalo/zaloAutoDeleteSync";
import { refreshZaloHidden, zaloHiddenApiOf } from "../../services/zalo/zaloHiddenConversations";
import { describeZaloSocketRetry, installZaloListenerRetryGuard } from "./zaloListenerRetry";
import { isQrLoginCancelled, qrLoginErrorText } from "../../shared/zalo/zaloQrLogin";
import { tr } from '../../shared/i18n';

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_BASE_MS = 5000; // 5s base, exponential backoff
/** zca-js reconnects the websocket by itself (retryOnClose): if it cannot reconnect for too long, log in again for the whole session as before. */
const ZCA_RETRY_WATCHDOG_MS = 90_000;

class ZaloLoginHelper {

    constructor() {}

    private createZaloConfig(options: any = {}, proxyAgent?: any) {
        const cfg: any = {
            selfListen: options.selfListen !== undefined ? options.selfListen : true,
            checkUpdate: options.checkUpdate !== undefined ? options.checkUpdate : false,
            logging: options.logging !== undefined ? options.logging : false,
            /**
             * imageMetadataGetter: required for uploadAttachment with photos (jpg/png/webp/gif) to work.
             * Uses image-size to read width/height and fs.stat to get the size.
             */
            imageMetadataGetter: async (filePath: string) => {
                try {
                    const stat = fs.statSync(filePath);
                    const buf = fs.readFileSync(filePath);
                    const dim = imageSize(buf);
                    return {
                        width: dim.width ?? 0,
                        height: dim.height ?? 0,
                        size: stat.size,
                    };
                } catch (e: any) {
                    Logger.warn(`[ZaloLoginHelper] imageMetadataGetter error for ${filePath}: ${e.message}`);
                    return null;
                }
            },
        };
        if (proxyAgent) {
            cfg.agent = proxyAgent;
            // Native global.fetch (undici) ignores the agent option entirely.
            // node-fetch v2 properly forwards the agent to proxy-agent (which handles all proxy types).
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const nodeFetch = require('node-fetch');
            // Capture proxyAgent in closure so ALL requests - login, sendMessage, getUserInfo,
            // WebSocket upgrade, file upload, etc. - always go through the proxy.
            // We explicitly spread `agent: proxyAgent` into every request's options so that
            // even if zca-js doesn't forward cfg.agent in a particular request, the proxy
            // is always applied by the polyfill itself.
            const capturedAgent = proxyAgent;
            cfg.polyfill = async (url: string, options: any) => {
                // Always inject the proxy agent - do NOT rely on zca-js forwarding cfg.agent
                const res = await nodeFetch(url, { ...options, agent: capturedAgent });
                // Patch each response to expose getSetCookie() - zca-js uses this to correctly parse
                // cookies with commas in values (e.g. Expires dates in checkSession redirect).
                // node-fetch v2 Headers lacks getSetCookie(); fallback split(", ") breaks those cookies.
                if (typeof res.headers.getSetCookie !== 'function') {
                    res.headers.getSetCookie = () => {
                        const raw = (res.headers as any).raw?.() ?? {};
                        return (raw['set-cookie'] as string[]) || [];
                    };
                }
                return res;
            };
        }
        return cfg;
    }

    /**
     * QR Code login
     */
    public async loginQR(tempId: string, proxyId?: number | null): Promise<void> {
        // Create the proxy agent if there is one
        const proxyAgent = proxyId
            ? createProxyAgent(DatabaseService.getInstance().getProxyById(proxyId))
            : undefined;
        const zalo = new Zalo(this.createZaloConfig({ selfListen: true }, proxyAgent));
        let account = { avatar: '', displayName: '' };
        let abortFn: (() => unknown) | null = null;
        /** zca-js code expired (100 s) / the user taps Decline on the phone: the QR round ends, not an error */
        let expired = false;
        let declined = false;

        // Keep the abort function so it can be cancelled from outside
        ZaloLoginHelper.activeQRAbortFns.set(tempId, () => { abortFn?.(); });

        const onQrEvent = (res: any) => {
            console.log(`[ZaloLoginHelper] loginQR event type: ${res.type}`, JSON.stringify((res as any).data || {}).substring(0, 100));

            if (res.type === LoginQRCallbackEventType.QRCodeGenerated) {
                // Keep the abort function from actions
                abortFn = (res as any).actions?.abort || null;

                // The actual field is data.image (raw base64, no prefix)
                const raw: string = (res as any).data?.image || (res as any).data?.qrData || '';
                const qrDataUrl = raw
                    ? (raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`)
                    : '';

                console.log(`[ZaloLoginHelper] QR generated, image length: ${raw.length}, tempId: ${tempId}`);
                EventBroadcaster.broadcastQRUpdate(tempId, qrDataUrl, 'waiting');
            }

            if (res.type === LoginQRCallbackEventType.QRCodeExpired) {
                expired = true;
                console.log(`[ZaloLoginHelper] QR expired for tempId: ${tempId}`);
                EventBroadcaster.broadcastQRUpdate(tempId, '', 'expired');
            }

            if (res.type === LoginQRCallbackEventType.QRCodeDeclined) {
                declined = true;
                console.log(`[ZaloLoginHelper] QR declined for tempId: ${tempId}`);
                EventBroadcaster.broadcastQRUpdate(tempId, '', 'declined');
                // With a callback, zca-js does NOT end the round after the phone reports a decline (the promise hangs until it is cancelled) → end it here
                (res as any).actions?.abort?.();
            }

            if (res.type === LoginQRCallbackEventType.QRCodeScanned) {
                account.avatar = (res as any).data?.avatar || '';
                account.displayName = (res as any).data?.display_name || '';
                console.log(`[ZaloLoginHelper] QR scanned: ${account.displayName}`);
                EventBroadcaster.broadcastQRUpdate(tempId, '', 'scanned');
            }
        };

        let api: API;
        try {
            api = await zalo.loginQR({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
            }, onQrEvent);
        } catch (err: any) {
            ZaloLoginHelper.activeQRAbortFns.delete(tempId);
            // "Operation aborted" = the app cancelled the QR round itself (window closed / Refresh / Decline); on expiry zca-js cancels the waiting round by itself
            // ("Cannot get scan/confirm result"). Not an error: only logged at the normal level.
            if (isQrLoginCancelled(err) || expired || declined) {
                Logger.log(`[ZaloLoginHelper] QR ${tempId} ${declined ? 'declined' : expired ? 'expired' : 'cancelled'} (${err?.message || err})`);
                return;
            }
            // A real error (after scanning / confirming): report it to the UI; previously the window stayed stuck at "Đang xác nhận trên điện thoại..." (Confirming on the phone...)
            EventBroadcaster.broadcastQRUpdate(tempId, '', 'error', qrLoginErrorText(err));
            throw err;
        }

        // Cleanup
        ZaloLoginHelper.activeQRAbortFns.delete(tempId);

        const context = api.getContext();
        const zaloId = api.getOwnId();

        if (!zaloId || !context) {
            EventBroadcaster.broadcastQRUpdate(tempId, '', 'error');
            throw new Error(tr('Đăng nhập QR thất bại'));
        }

        const cookiesJson = JSON.stringify(context.cookie.serializeSync());
        const auth = {
            cookies: cookiesJson,
            imei: context.imei,
            userAgent: context.userAgent,
            // Preserve proxyId so auto-reconnect (scheduleReconnect) uses the
            // correct proxy without relying on the cookie-string DB lookup fallback.
            proxyId: proxyId ?? null,
        };

        // 1. Check first whether this is a new account (not yet in the DB)
        const isNewAccount = !DatabaseService.getInstance().hasAccount(zaloId);

        // 2. Save the account to the DB BEFORE broadcasting success
        //    → when the renderer receives 'success' and calls getAccounts(), the account is already there
        let savedPhone = (account as any).phoneNumber || (account as any).phone || '';
        try {
            DatabaseService.getInstance().saveAccount({
                zalo_id: zaloId,
                full_name: account.displayName || '',
                avatar_url: account.avatar || '',
                phone: savedPhone,
                imei: auth.imei,
                user_agent: auth.userAgent,
                cookies: auth.cookies,
                is_active: 1,
                created_at: new Date().toISOString(),
            });
            // Attach the proxy if there is one
            if (proxyId) {
                DatabaseService.getInstance().setAccountProxy(zaloId, proxyId);
            }
            Logger.log(`[ZaloLoginHelper] Account ${zaloId} saved to DB`);
        } catch (dbErr: any) {
            Logger.error(`[ZaloLoginHelper] Failed to save account: ${dbErr.message}`);
        }

        // 3. Connect and start the listener
        await this.connectZaloUser(auth, api);

        // 4. Fetch the phone + bizPkg from the API and update the DB - BEFORE broadcasting success
        //    So that when the renderer + loginIpc call getAccounts/registerPage, the phone is already complete
        try {
            const accountInfo = await api.fetchAccountInfo();
            const phone: string = accountInfo?.profile?.phoneNumber || (accountInfo as any)?.phoneNumber || '';
            // An empty phone keeps the saved number; the Business flag goes through applyZaloBusinessFlag (if it cannot be read, it stays as is)
            DatabaseService.getInstance().updateAccountInfo(zaloId, phone, null);
            const isBusiness = applyZaloBusinessFlag(zaloId, accountInfo);
            if (phone) savedPhone = phone;
            Logger.log(`[ZaloLoginHelper] Updated ${zaloId}: phone=${phone}, isBusiness=${isBusiness}`);
        } catch (err: any) {
            Logger.warn(`[ZaloLoginHelper] fetchAccountInfo after QR failed: ${err.message}`);
        }

        // 5. Broadcast success AFTER saving + connecting + fetching the phone
        EventBroadcaster.broadcastQRUpdate(tempId, '', 'success');
        Logger.log(`[ZaloLoginHelper] QR Login success: ${zaloId}`);

        // 6. Callback after a successful QR login
        if (ZaloLoginHelper.onQRSuccessCallback) {
            try { ZaloLoginHelper.onQRSuccessCallback(zaloId, isNewAccount); } catch {}
        }

        // 7. If it is a new account → fetch all friends + groups + members in the background
        if (isNewAccount) {
            ZaloLoginHelper.fetchAllFriendsInBackground(zaloId, api);
            ZaloLoginHelper.fetchAllGroupsInBackground(zaloId, api);
        }
    }

    // Map holding the abort functions for the pending QR logins
    private static activeQRAbortFns: Map<string, () => void> = new Map();
    // Set holding the group IDs whose info has been fetched, to avoid calling again
    // ⚠️ FIX: limit to 2000 entries to avoid an unlimited memory leak
    private static fetchedGroupIds: Set<string> = new Set();
    private static readonly MAX_FETCHED_GROUP_CACHE = 2000;

    /** Add the key to fetchedGroupIds, with LRU eviction when full */
    private static addToFetchedGroupCache(key: string): void {
        if (ZaloLoginHelper.fetchedGroupIds.size >= ZaloLoginHelper.MAX_FETCHED_GROUP_CACHE) {
            // Remove the oldest entry (first inserted)
            const firstKey = ZaloLoginHelper.fetchedGroupIds.values().next().value;
            if (firstKey) ZaloLoginHelper.fetchedGroupIds.delete(firstKey);
        }
        ZaloLoginHelper.fetchedGroupIds.add(key);
    }
    // Count the reconnect attempts in progress for each account
    private static reconnectAttempts: Map<string, number> = new Map();
    // Timer handles so they can be cancelled
    private static reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    // Set of accounts that were deleted on purpose - do NOT reconnect
    private static removedAccounts: Set<string> = new Set();
    /** Callback called when the QR login succeeds */
    private static onQRSuccessCallback: ((zaloId: string, isNewAccount: boolean) => void) | null = null;

    public static setQRSuccessCallback(cb: (zaloId: string, isNewAccount: boolean) => void): void {
        ZaloLoginHelper.onQRSuccessCallback = cb;
    }

    /** Callback called after fetching phone/bizPkg completes - used to sync the phone to Sheets */
    private static onProfileReadyCallback: ((zaloId: string, name: string, phone: string) => void) | null = null;

    public static setProfileReadyCallback(cb: (zaloId: string, name: string, phone: string) => void): void {
        ZaloLoginHelper.onProfileReadyCallback = cb;
    }

    /** Mark the account as deleted - prevents reconnecting when the listener disconnects */
    public static markRemoved(zaloId: string): void {
        ZaloLoginHelper.removedAccounts.add(zaloId);
        ZaloLoginHelper.cancelReconnect(zaloId);
    }

    /** Unmark (used when the account is added again) */
    public static unmarkRemoved(zaloId: string): void {
        ZaloLoginHelper.removedAccounts.delete(zaloId);
    }

    /** Abort the pending QR login */
    public static abortQR(tempId: string): void {
        const fn = ZaloLoginHelper.activeQRAbortFns.get(tempId);
        if (fn) { fn(); ZaloLoginHelper.activeQRAbortFns.delete(tempId); }
    }

    /**
     * Schedule a reconnect with exponential backoff.
     * attempt=0 → delay=5s, 1→10s, 2→20s, 3→40s, 4→80s → then mark as dead.
     */
    public static scheduleReconnect(zaloId: string, auth: any, attempt: number): void {
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            Logger.error(`[ZaloLoginHelper] ${zaloId} max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached - marking listener_active=0`);
            DatabaseService.getInstance().setListenerActive(zaloId, false);
            EventBroadcaster.broadcastListenerDead(zaloId, 'max_retries');
            ZaloLoginHelper.reconnectAttempts.delete(zaloId);
            return;
        }


        const delay = RECONNECT_DELAY_BASE_MS * Math.pow(2, attempt);
        Logger.log(`[ZaloLoginHelper] ${zaloId} scheduling reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

        // Cancel any pending timer
        const existing = ZaloLoginHelper.reconnectTimers.get(zaloId);
        if (existing) clearTimeout(existing);

        ZaloLoginHelper.reconnectAttempts.set(zaloId, attempt);

        const timer = setTimeout(async () => {
            ZaloLoginHelper.reconnectTimers.delete(zaloId);

            // If the listener was restored while waiting (e.g. the user logged in again with QR)
            // → no need to reconnect anymore
            if (ConnectionManager.isListenerStarted(zaloId)) {
                Logger.log(`[ZaloLoginHelper] ${zaloId} already reconnected while waiting - cancelling attempt ${attempt + 1}`);
                ZaloLoginHelper.reconnectAttempts.delete(zaloId);
                return;
            }

            // If the account was deleted while the timer was waiting → do not reconnect
            if (ZaloLoginHelper.removedAccounts.has(zaloId)) {
                Logger.log(`[ZaloLoginHelper] ${zaloId} was removed - cancelling reconnect attempt ${attempt + 1}`);
                ZaloLoginHelper.reconnectAttempts.delete(zaloId);
                return;
            }

            Logger.log(`[ZaloLoginHelper] ${zaloId} attempting reconnect #${attempt + 1}...`);
            try {
                const helper = new ZaloLoginHelper();
                const success = await helper.connectZaloUser(auth);
                if (success) {
                    Logger.log(`[ZaloLoginHelper] ${zaloId} ✅ reconnect #${attempt + 1} success`);
                    ZaloLoginHelper.reconnectAttempts.delete(zaloId);
                    DatabaseService.getInstance().setListenerActive(zaloId, true);
                    // The connected event will be broadcast by setupEventListeners
                } else {
                    ZaloLoginHelper.scheduleReconnect(zaloId, auth, attempt + 1);
                }
            } catch (err: any) {
                Logger.warn(`[ZaloLoginHelper] ${zaloId} reconnect #${attempt + 1} failed: ${err.message}`);
                ZaloLoginHelper.scheduleReconnect(zaloId, auth, attempt + 1);
            }
        }, delay);

        ZaloLoginHelper.reconnectTimers.set(zaloId, timer);
    }

    /** Cancel the pending reconnect timer (when the user disconnects manually) */
    public static cancelReconnect(zaloId: string): void {
        const timer = ZaloLoginHelper.reconnectTimers.get(zaloId);
        if (timer) { clearTimeout(timer); ZaloLoginHelper.reconnectTimers.delete(zaloId); }
        ZaloLoginHelper.reconnectAttempts.delete(zaloId);
    }

    /** Clear the fetchedGroupIds cache for 1 group so it can be fetched again when a group_event changes it */
    public static invalidateGroupCache(zaloId: string, groupId: string): void {
        const cacheKey = `${zaloId}_${groupId}`;
        ZaloLoginHelper.fetchedGroupIds.delete(cacheKey);
        Logger.log(`[ZaloLoginHelper] Invalidated group cache for ${groupId}`);
    }

    /**
     * Fetch group info in the background if not already fetched.
     * Updates the DB contact with the proper group name & avatar, and saves the members.
     * Only calls the API if:
     * 1. It is not yet in fetchedGroupIds (session cache)
     * 2. There is no real name in the DB yet
     */
    private static async fetchGroupInfoIfMissing(zaloId: string, groupId: string, api: any): Promise<void> {
        const cacheKey = `${zaloId}_${groupId}`;
        if (ZaloLoginHelper.fetchedGroupIds.has(cacheKey)) return;

        try {
            // Always read/write boss DB (cross-workspace safe)
            const db = DatabaseService.getInstance();
            let existing: any = null;
            let existingMembers: any[] = [];
            EventBroadcaster.runOnBossDb((bossDb) => {
                existing = bossDb.getContactById(zaloId, groupId);
                existingMembers = bossDb.getGroupMembers(zaloId, groupId) || [];
            });

            // Check the DB with a single-row lookup instead of loading all contacts
            const hasRealName = existing && existing.display_name &&
                existing.display_name !== groupId && !existing.display_name.match(/^\d+$/);

            const hasMembers = Array.isArray(existingMembers) && existingMembers.length > 0;

            // If both the name and the members are already complete → mark and skip
            if (hasRealName && hasMembers) {
                ZaloLoginHelper.addToFetchedGroupCache(cacheKey);
                return;
            }

            ZaloLoginHelper.addToFetchedGroupCache(cacheKey); // Mark before fetch to prevent parallel calls

            const res = await api.getGroupInfo(groupId);
            const groupData = res?.changed_groups?.[groupId] || res?.gridInfoMap?.[groupId];
            if (!groupData) return;

            const name: string = groupData.name || groupData.nameChanged || groupId;
            const avatar: string = groupData.avt || groupData.fullAvt || '';
            const creatorId: string = groupData.creatorId || groupData.creator || '';
            const adminIds: string[] = groupData.adminIds || groupData.subAdmins || [];

            // Update the group name if missing - always write to the owner's machine DB
            if (!hasRealName) {
                EventBroadcaster.runOnBossDb((bossDb) => bossDb.updateContactProfile(zaloId, groupId, name, avatar));
                Logger.log(`[ZaloLoginHelper] ✅ Fetched group info for ${groupId}: "${name}"`);
                EventBroadcaster.broadcastGroupInfoUpdate(zaloId, groupId, name, avatar, groupData);
            }

            // Save the members if missing - always write to the owner's machine DB
            if (!hasMembers) {
                const rawMembers: any[] = groupData.memVerList || groupData.memberList ||
                    groupData.members || groupData.currentMems || [];
                if (rawMembers.length > 0) {
                    // memVerList may be an array of strings "uid_version" or an array of objects
                    const members = rawMembers.map((m: any) => {
                        let memberId: string;
                        if (typeof m === 'string') {
                            memberId = m.replace(/_\d+$/, ''); // "uid_0" → "uid"
                        } else {
                            memberId = String(m.id || m.userId || m.uid || m.memberId || '');
                        }
                        return {
                            memberId,
                            displayName: (typeof m === 'object' ? (m.dName || m.displayName || m.name || '') : ''),
                            avatar: (typeof m === 'object' ? (m.avt || m.avatar || '') : ''),
                            role: memberId === creatorId ? 1 :
                                adminIds.includes(memberId) ? 2 : 0,
                        };
                    }).filter((m: any) => m.memberId);

                    if (members.length > 0) {
                        EventBroadcaster.runOnBossDb((bossDb) => bossDb.saveGroupMembers(zaloId, groupId, members));
                        Logger.log(`[ZaloLoginHelper] ✅ Saved ${members.length} members for group ${groupId}`);
                    }
                }
            }
        } catch (err: any) {
            Logger.warn(`[ZaloLoginHelper] fetchGroupInfoIfMissing failed for ${groupId}: ${err.message}`);
            ZaloLoginHelper.fetchedGroupIds.delete(cacheKey); // allow retry
        }
    }

    /**
     * Fetch all groups in the background when the account logs in for the first time.
     * Calls getAllGroups → gets the groupId list → fetches the info + members of each group.
     * Processes in parallel by batch (concurrency=5) to reduce the waiting time.
     */
    private static async fetchAllGroupsInBackground(zaloId: string, api: any): Promise<void> {
        try {
            Logger.log(`[ZaloLoginHelper] 🔍 [FirstLogin] Fetching all groups for new account ${zaloId}...`);
            const res = await api.getAllGroups();
            const groupIds = Object.keys(res?.gridVerMap || {});
            Logger.log(`[ZaloLoginHelper] [FirstLogin] Found ${groupIds.length} groups for ${zaloId}`);

            const CONCURRENCY = 5;
            for (let i = 0; i < groupIds.length; i += CONCURRENCY) {
                const batch = groupIds.slice(i, i + CONCURRENCY);
                await Promise.allSettled(
                    batch.map(groupId => ZaloLoginHelper.fetchGroupInfoIfMissing(zaloId, groupId, api))
                );
                // Short delay between batches so as not to spam the API
                if (i + CONCURRENCY < groupIds.length) {
                    await new Promise<void>((r) => setTimeout(r, 300));
                }
            }
            Logger.log(`[ZaloLoginHelper] ✅ [FirstLogin] Done fetching all groups for ${zaloId}`);
        } catch (err: any) {
            Logger.warn(`[ZaloLoginHelper] fetchAllGroupsInBackground failed: ${err.message}`);
        }
    }

    /**
     * Fetch all friends in the background when the account logs in for the first time.
     * Calls getAllFriends → normalize → saves to the friends table + updates contacts.
     * Uses batch insert to avoid N disk writes (10k friends = 1 disk write instead of 10k).
     */
    private static async fetchAllFriendsInBackground(zaloId: string, api: any): Promise<void> {
        try {
            Logger.log(`[ZaloLoginHelper] 👥 [FirstLogin] Fetching all friends for new account ${zaloId}...`);
            const db = DatabaseService.getInstance();

            const res = await api.getAllFriends();
            // The API returns User[] or an object map
            let list: any[] = [];
            if (Array.isArray(res)) list = res;
            else if (res && typeof res === 'object') list = Object.values(res);

            if (list.length === 0) {
                Logger.log(`[ZaloLoginHelper] [FirstLogin] No friends found for ${zaloId}`);
                return;
            }

            // Normalize and save to the friends table (batch - single disk write)
            const normalized = list.map((f: any) => ({
                userId: f.userId || f.uid || '',
                displayName: f.displayName || f.zaloName || f.display_name || '',
                avatar: f.avatar || '',
                phoneNumber: f.phoneNumber || f.phone || '',
            })).filter((f: any) => f.userId);

            if (normalized.length > 0) {
                db.saveFriends(zaloId, normalized);
                Logger.log(`[ZaloLoginHelper] [FirstLogin] Saved ${normalized.length} friends to friends table`);

                // Batch upsert contacts (single disk write instead of N writes)
                const contactBatch = normalized.map(f => ({
                    owner_zalo_id: zaloId,
                    contact_id: f.userId,
                    display_name: f.displayName,
                    avatar_url: f.avatar,
                    phone: f.phoneNumber,
                    is_friend: 1,
                    contact_type: 'user',
                    unread_count: 0,
                    last_message: '',
                    last_message_time: 0,
                }));
                db.saveContactsBatch(contactBatch);
                Logger.log(`[ZaloLoginHelper] ✅ [FirstLogin] Batch saved ${contactBatch.length} friends to contacts table for ${zaloId}`);
            }
        } catch (err: any) {
            Logger.warn(`[ZaloLoginHelper] fetchAllFriendsInBackground failed: ${err.message}`);
        }
    }

    /**
     * Log in with Cookies/IMEI
     */
    public async loginCookies(imei: string, cookies: string, userAgent: string, proxyId?: number | null): Promise<any> {
        const proxyAgent = proxyId
            ? createProxyAgent(DatabaseService.getInstance().getProxyById(proxyId))
            : undefined;
        const zalo = new Zalo(this.createZaloConfig({ selfListen: true }, proxyAgent));

        const credentials: Partial<Credentials> = {
            cookie: JSON.parse(cookies),
            imei,
            userAgent,
        };

        try {
            const api = await zalo.login(credentials as Credentials);
            const zaloId = api.getOwnId();

            if (!zaloId) throw new Error(tr('Login thất bại: không lấy được zaloId'));

            const isNewAccount = !DatabaseService.getInstance().hasAccount(zaloId);
            const accountInfo = await api.fetchAccountInfo();

            await this.connectZaloUser({ imei, cookies, userAgent, proxyId: proxyId ?? null }, api);

            // If it is a new account → fetch all friends + groups + members in the background
            if (isNewAccount) {
                ZaloLoginHelper.fetchAllFriendsInBackground(zaloId, api);
                ZaloLoginHelper.fetchAllGroupsInBackground(zaloId, api);
            }

            Logger.log(`[ZaloLoginHelper] Cookies login success: ${zaloId}`);
            return accountInfo;
        } catch (error: any) {
            Logger.error(`[ZaloLoginHelper] loginCookies failed: ${error.message}`);
            throw new Error(tr('Đăng nhập thất bại: {{message}}', { message: error.message }));
        }
    }

    /**
     * Connect the user, set up the listeners
     */
    public async connectZaloUser(
        auth: { cookies: string; imei: string; userAgent: string; proxyId?: number | null },
        api?: API
    ): Promise<boolean> {
        try {
            Logger.log(`[ZaloLoginHelper] connectZaloUser starting...`);

            // If this is a fresh login (api provided from QR/cookies),
            // cancel the pending reconnect timer right away to avoid a race condition
            if (api) {
                const freshZaloId = api.getOwnId();
                if (freshZaloId) ZaloLoginHelper.cancelReconnect(freshZaloId);
            }

            const connection = await ConnectionManager.getOrCreateConnection(auth, true, api);
            const zaloId = connection.api.getOwnId();

            // Clear the "removed" mark if the account is connected again
            ZaloLoginHelper.removedAccounts.delete(zaloId);

            if (ConnectionManager.isListenerStarted(zaloId)) {
                Logger.log(`[ZaloLoginHelper] ${zaloId} already has active listener`);
                return true;
            }

            this.setupEventListeners(zaloId, connection);
            // Once the app has settled: re-read the Zalo Business flag (QR / cookie login already read it) and the list of conversations that have
            // auto-delete on (ZL-05: Zalo does not notify when it is changed on the phone). Each task runs at most once per 6 hours per account.
            const syncApi = connection.api as any;
            whenStartupSettled(() => {
                if (!api) void refreshZaloBusinessFlag(zaloId, syncApi);
                void refreshZaloAutoDelete(zaloId, syncApi);
                void refreshZaloHidden(zaloId, zaloHiddenApiOf(syncApi));
            });
            return true;
        } catch (error: any) {
            Logger.error(`[ZaloLoginHelper] connectZaloUser failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Disconnect the user
     */
    public async disconnectUser(zaloId: string): Promise<void> {
        // Cancel any pending reconnect so we don't re-connect after manual disconnect
        ZaloLoginHelper.cancelReconnect(zaloId);

        const connection = ConnectionManager.getConnection(zaloId);
        if (!connection) {
            Logger.warn(`[ZaloLoginHelper] ${zaloId} not found`);
            return;
        }

        const authKey = connection.authKey;

        if (connection.listener) {
            try {
                if (ConnectionManager.isConnected(zaloId)) {
                    connection.listener.stop();
                    Logger.log(`[ZaloLoginHelper] ${zaloId} listener stopped`);
                }
            } catch (error: any) {
                Logger.warn(`[ZaloLoginHelper] Stop listener warning: ${error.message}`);
            }
            ConnectionManager.setListenerStarted(zaloId, false);
        }

        ConnectionManager.removeConnection(zaloId);
        ConnectionManager.clearConnectionLock(zaloId);
        if (authKey) ConnectionManager.removePendingConnection(authKey);

        Logger.log(`[ZaloLoginHelper] ${zaloId} disconnected`);
    }

    /**
     * Disconnect all
     */
    public async disconnectAllUsers(): Promise<boolean> {
        const connections = ConnectionManager.getAllConnections();
        for (const zaloId of connections.keys()) {
            await this.disconnectUser(zaloId);
        }
        return true;
    }

    /**
     * Zalo login (internal)
     */
    public async loginZalo(
        auth: { cookies: string; imei: string; userAgent: string; proxyId?: number | null }
    ): Promise<API> {
        // Create the proxy agent if auth has a proxyId
        let proxyAgent: any;
        if (auth.proxyId) {
            const proxyConfig = DatabaseService.getInstance().getProxyById(auth.proxyId);
            proxyAgent = createProxyAgent(proxyConfig);
        } else {
            // Try to get the proxy from the DB by cookies (when reconnecting after startup)
            try {
                const accounts = DatabaseService.getInstance().getAccounts();
                const match = accounts.find((a: any) => a.cookies === auth.cookies);
                if ((match as any)?.proxy_id) {
                    const proxyConfig = DatabaseService.getInstance().getProxyById((match as any).proxy_id);
                    proxyAgent = createProxyAgent(proxyConfig);
                }
            } catch {}
        }

        const zalo = new Zalo(this.createZaloConfig({ selfListen: true }, proxyAgent));

        let cookieParsed: any;
        try {
            cookieParsed = JSON.parse(auth.cookies);
        } catch {
            const prefix = (auth.cookies || '').substring(0, 40);
            const len = (auth.cookies || '').length;
            console.error(`[loginZalo] JSON.parse FAIL: len=${len}, prefix="${prefix}", startsWith=${JSON.stringify((auth.cookies || '').substring(0, 5))}`);
            throw new Error(
                'Cookies tài khoản không hợp lệ (có thể bị mã hóa sai hoặc dữ liệu cũ). ' +
                'Vui lòng đăng xuất và đăng nhập lại tài khoản này.'
            );
        }

        const credentials: Partial<Credentials> = {
            cookie: cookieParsed,
            imei: auth.imei,
            userAgent: auth.userAgent,
        };

        return await zalo.login(credentials as Credentials);
    }

    /** ID of the account's "My Documents" conversation (zca-js `loginInfo.send2me_id`), '' if the session has none. */
    private static readSend2MeId(connection: any): string {
        try {
            const id = connection?.api?.getContext?.()?.loginInfo?.send2me_id;
            return id ? String(id) : '';
        } catch {
            return '';
        }
    }

    /**
     * Set up the event listeners and broadcast through EventBroadcaster
     */
    private setupEventListeners(zaloId: string, connection: any): void {
        const { listener } = connection;
        // Zalo's My Documents = a separate conversation with its own ID in the login session (NOT the user's own UID)
        const send2meId = ZaloLoginHelper.readSend2MeId(connection);
        if (send2meId) {
            try { DatabaseService.getInstance().setAccountSend2MeId(zaloId, send2meId); } catch {}
        }
        Logger.log(`[ZaloLoginHelper] ${zaloId} My Documents thread = ${send2meId || '(phiên không có send2me_id)'}`);

        listener.on("message", async (message: any) => {
            try {
                // DEBUG LOG: see the real message structure from zca-js (main process)
                Logger.log(`[ZaloLoginHelper] 📩 RAW message event: ${JSON.stringify({
                    type: message.type,
                    threadId: message.threadId,
                    isSelf: message.isSelf,
                    'data.uidFrom': message.data?.uidFrom,
                    'data.idTo': message.data?.idTo,
                    'data.msgId': message.data?.msgId,
                    'data.msgType': message.data?.msgType,
                    'data.ts': message.data?.ts,
                    'data.content_type': typeof message.data?.content,
                    'data.content': message.data?.content,
                    'data.message': (message.data as any)?.message,
                    'top_level_keys': Object.keys(message),
                    'full_message': message,
                })}`);

                // ─── Handle chat.delete (delete a message on my side) ─────────────────
                const msgType = message.data?.msgType as string;
                if (msgType === 'chat.delete') {
                    const threadId = message.threadId || '';
                    const contentArr: any[] = Array.isArray(message.data?.content) ? message.data.content : [];
                    // Get globalDelMsgId from the delete items array
                    const msgIds: string[] = contentArr
                        .map((item: any) => String(item.globalDelMsgId || item.clientDelMsgId || ''))
                        .filter(Boolean);
                    Logger.log(`[ZaloLoginHelper] 🗑️ chat.delete: thread=${threadId} msgIds=${JSON.stringify(msgIds)}`);
                    EventBroadcaster.broadcastDeleteMessages(zaloId, msgIds, threadId);
                    return;
                }

                // ─── Handle chat.reaction: skipped, already handled by the "reaction" listener ──
                if (msgType === 'chat.reaction') {
                    return;
                }

                // ─── Handle chat.ecard (reminder notification) ─────────────────
                if (msgType === 'chat.ecard') {
                    const content = message.data?.content;
                    if (content && typeof content === 'object') {
                        const params = typeof content.params === 'string' ? (() => {
                            try { return JSON.parse(content.params); } catch { return null; }
                        })() : content.params;

                        // Check whether this is a reminder
                        if (params?.actions?.[0]?.actionId === 'action.open.reminder') {
                            Logger.log(`[ZaloLoginHelper] ⏰ Reminder notification: thread=${message.threadId} title="${content.title}"`);
                            EventBroadcaster.broadcastReminderNotification(zaloId, message.threadId || '', msgType, content);
                        }
                    }
                }

                message.zaloId = zaloId;

                // A workflow is started by broadcastMessage. Resolve the group name
                // first so $trigger.groupName is available during that same run,
                // rather than only on the next message after a background refresh.
                if (message.type === 1) {
                    const groupId = message.threadId || '';
                    if (groupId) {
                        await ZaloLoginHelper.fetchGroupInfoIfMissing(zaloId, groupId, connection.api);
                        let cachedGroupName = '';
                        EventBroadcaster.runOnBossDb((bossDb) => {
                            cachedGroupName = String(bossDb.getContactById(zaloId, groupId)?.display_name || '');
                        });
                        if (cachedGroupName && cachedGroupName !== groupId && !/^\d+$/.test(cachedGroupName)) {
                            message.groupName = cachedGroupName;
                        }
                    }
                }
                await EventBroadcaster.broadcastMessage(zaloId, message);
            } catch (error: any) {
                Logger.error(`[ZaloLoginHelper] message event error: ${error.message}`);
            }
        });

        listener.on("group_event", (event: any) => {
            Logger.log(`[ZaloLoginHelper] 📩 RAW group_event event: ${JSON.stringify({
                event: event,
            })}`);

            try {
                const groupId = event.threadId || event.data?.groupId || event.groupId || '';
                EventBroadcaster.broadcastGroupEvent(zaloId, groupId, event.type, event);

                // For member-change events EventBroadcaster already updates DB surgically,
                // so no need to fetch full group info. Only fetch for structural events
                // where group name/avatar may be missing (new group, update, etc.)
                const MEMBER_EVENTS = new Set(['join', 'leave', 'remove_member', 'block_member', 'add_admin', 'remove_admin']);
                if (groupId && !MEMBER_EVENTS.has(event.type)) {
                    ZaloLoginHelper.fetchGroupInfoIfMissing(zaloId, groupId, connection.api);
                }
            } catch (error: any) {
                Logger.error(`[ZaloLoginHelper] group_event error: ${error.message}`);
            }
        });

        listener.on("reaction", async (reaction: any) => {
            try {
                // DEBUG: log the whole reaction object
                Logger.log(`[ZaloLoginHelper] 🎭 RAW reaction: ${JSON.stringify({
                    top_keys: Object.keys(reaction),
                    threadId: reaction.threadId,
                    msgId: reaction.msgId || reaction.data?.msgId,
                    uidFrom: reaction.uidFrom || reaction.data?.uidFrom,
                    content: reaction.content || reaction.data?.content,
                    rIcon: reaction.rIcon || reaction.data?.rIcon || reaction.data?.content?.rIcon,
                    full: reaction,
                })}`);

                // ─── Check whether the reaction sender is already in the system ──────
                const rData = reaction.data || {};
                const uidFrom = String(rData.uidFrom || reaction.uidFrom || '');
                const threadId: string = reaction.threadId || rData.idTo || rData.threadId || '';
                const isGroup: boolean = !!reaction.isGroup;

                if (uidFrom && uidFrom !== zaloId) {
                    const db = DatabaseService.getInstance();
                    let isKnown = false;

                    // ⚠️ FIX: Use a single-row lookup instead of loading all contacts.
                    // db.getContacts() loads the WHOLE contacts list on every reaction → memory spike that accumulates → OOM.
                    // Check the group member table first (if it is a group reaction)
                    if (isGroup && threadId) {
                        const members = db.getGroupMembers(zaloId, threadId);
                        isKnown = members.some((m: any) => m.member_id === uidFrom);
                    }
                    // Check with a single-row lookup instead of loading all contacts
                    if (!isKnown) {
                        isKnown = !!db.getContactById(zaloId, uidFrom);
                    }

                    if (!isKnown) {
                        // The user is not in the system yet → fetch the info and save it to the DB
                        try {
                            const userInfoRes = await connection.api.getUserInfo(uidFrom);
                            const profile = userInfoRes?.changed_profiles?.[uidFrom]
                                || (userInfoRes as any)?.data?.[uidFrom];
                            if (profile) {
                                const { displayName, avatar, phone, gender, birthday } = extractUserProfile(profile);
                                if (isGroup && threadId) {
                                    db.upsertGroupMember(zaloId, threadId, {
                                        memberId: uidFrom,
                                        displayName,
                                        avatar,
                                        role: 0,
                                    });
                                    Logger.log(`[ZaloLoginHelper] ✅ Added reaction sender ${uidFrom} (${displayName}) to group members of ${threadId}`);
                                } else {
                                    db.updateContactProfile(zaloId, uidFrom, displayName, avatar, phone, '', gender, birthday);
                                    Logger.log(`[ZaloLoginHelper] ✅ Added reaction sender ${uidFrom} (${displayName}) to contacts`);
                                }
                            }
                        } catch (fetchErr: any) {
                            Logger.warn(`[ZaloLoginHelper] Failed to fetch reaction sender ${uidFrom}: ${fetchErr.message}`);
                        }
                    }
                }
                // ────────────────────────────────────────────────────────────────

                reaction.zaloId = zaloId;
                EventBroadcaster.broadcastReaction(zaloId, reaction);
            } catch (error: any) {
                Logger.error(`[ZaloLoginHelper] reaction event error: ${error.message}`);
            }
        });

        listener.on("undo", (undo: any) => {
            try {
                // Undo structure (zca-js Undo class):
                //   undo.data        - TUndo object
                //   undo.data.content - TUndoContent { globalMsgId, cliMsgId, deleteMsg, srcId, destId }
                //   undo.threadId    - thread containing the recalled message
                //   undo.isSelf      - true if I unsent it
                //   undo.isGroup     - true if it is a group
                //
                // ID to use: content.globalMsgId (the ID of the unsent message)
                // Do NOT use undo.data.msgId (that is the ID of the undo action, not of the original message)

                const d: any = undo.data || undo;
                const content = d.content || {};
                // globalMsgId is a large numeric ID → convert it to a string
                const recalledMsgId = String(
                    content.globalMsgId ||
                    content.cliMsgId ||
                    d.realMsgId ||
                    d.msgId ||
                    undo.msgId || ''
                );
                const threadId: string = undo.threadId || d.idTo || d.srcId || '';

                Logger.log(`[ZaloLoginHelper] ↩️ undo: recalledMsgId=${recalledMsgId} threadId=${threadId} isSelf=${undo.isSelf} isGroup=${undo.isGroup} raw=${JSON.stringify({
                    msgId: d.msgId, realMsgId: d.realMsgId,
                    'content.globalMsgId': content.globalMsgId,
                    'content.cliMsgId': content.cliMsgId,
                    threadId: undo.threadId,
                })}`);

                if (recalledMsgId) {
                    EventBroadcaster.broadcastUndo(zaloId, recalledMsgId, threadId);
                }
            } catch (error: any) {
                Logger.error(`[ZaloLoginHelper] undo event error: ${error.message}`);
            }
        });

        listener.on("typing", (data: any) => {
            Logger.log(`[ZaloLoginHelper] 📩 RAW typing event: ${JSON.stringify(data)}`);
            try {
                EventBroadcaster.broadcastTyping(zaloId, data);
            } catch {}
        });

        // zca-js 2.x emits "seen_messages" / "delivered_messages" (arrays). Previously it listened for "seen", a name that was never
        // emitted, so Zalo's "Đã xem" (seen) never ran. Seen / delivered → the conversation's timestamps (✓✓ marks next to the sent message time).
        const listenAny = listener as any;
        listenAny.on("seen_messages", (messages: any) => {
            for (const data of Array.isArray(messages) ? messages : [messages]) {
                try {
                    EventBroadcaster.broadcastSeen(zaloId, data);
                    recordZaloReceipt(zaloId, data, 'read');
                } catch (err: any) {
                    Logger.warn(`[ZaloLoginHelper] seen_messages error: ${err?.message || err}`);
                }
            }
        });
        listenAny.on("delivered_messages", (messages: any) => {
            for (const data of Array.isArray(messages) ? messages : [messages]) {
                try {
                    recordZaloReceipt(zaloId, data, 'delivered');
                } catch (err: any) {
                    Logger.warn(`[ZaloLoginHelper] delivered_messages error: ${err?.message || err}`);
                }
            }
        });

        listener.on("friend_event", async (event: any) => {
            Logger.log(`[ZaloLoginHelper] 📩 RAW friend_event event: ${JSON.stringify(event)}`);
            try {
                const eventType: number = event?.type ?? -1;
                const isSelf: boolean = event?.isSelf === true;
                const d = event?.data;
                const resolveFriendUserId = (raw: any, prefer: 'from' | 'to' | 'auto' = 'auto'): string => {
                    if (typeof raw === 'string') return raw;
                    if (prefer === 'from') {
                        return String(raw?.fromUid || raw?.uid || raw?.userId || raw?.actorId || raw?.toUid || '');
                    }
                    if (prefer === 'to') {
                        return String(raw?.toUid || raw?.uid || raw?.userId || raw?.fromUid || raw?.actorId || '');
                    }
                    return String(raw?.fromUid || raw?.uid || raw?.userId || raw?.toUid || raw?.actorId || '');
                };
                const resolveFriendMessage = (raw: any): string => {
                    if (!raw || typeof raw !== 'object') return '';
                    return String(raw.message || raw.msg || raw?.recommInfo?.message || raw?.recommInfo?.customText || '');
                };
                const fetchFriendProfile = async (userId: string) => {
                    let displayName = '';
                    let avatar = '';
                    let phone = '';
                    try {
                        const userInfoRes = await connection.api.getUserInfo(userId);
                        const rawProfile = userInfoRes?.changed_profiles?.[userId]
                            || (userInfoRes as any)?.data?.[userId];
                        if (rawProfile) {
                            const extracted = extractUserProfile(rawProfile);
                            displayName = extracted.displayName;
                            avatar = extracted.avatar;
                            phone = extracted.phone;
                            const db = DatabaseService.getInstance();
                            db.updateContactProfile(zaloId, userId, displayName, avatar, phone, '', extracted.gender, extracted.birthday);
                        }
                    } catch (err: any) {
                        Logger.warn(`[ZaloLoginHelper] friend_event getUserInfo(${userId}) failed: ${err.message}`);
                    }
                    return { displayName, avatar, phone };
                };

                // ── FriendEventType.REQUEST (2) - req_v2 event, direction depends on isSelf ──
                if (eventType === 2 && d && typeof d === 'object') {
                    const friendId = isSelf
                        ? resolveFriendUserId(d, 'to')
                        : resolveFriendUserId(d, 'from');
                    const msg = resolveFriendMessage(d);
                    if (!friendId) {
                        Logger.warn(`[ZaloLoginHelper] friend_event REQUEST missing peer userId (isSelf=${isSelf})`);
                        return;
                    }

                    const { displayName, avatar, phone } = await fetchFriendProfile(friendId);

                    if (isSelf) {
                        EventBroadcaster.broadcastFriendRequestSent(zaloId, {
                            userId: friendId,
                            displayName,
                            avatar,
                            phoneNumber: phone,
                            msg,
                        });
                    } else {
                        EventBroadcaster.broadcastFriendRequest(zaloId, {
                            userId: friendId,
                            displayName,
                            avatar,
                            phoneNumber: phone,
                            msg,
                        });
                    }
                    return;
                }

                // ── FriendEventType.ADD(0) - Became friends ─────────────────
                if (eventType === 0 && d) {
                    const friendId = resolveFriendUserId(d);
                    if (friendId) {
                        const { displayName, avatar, phone } = await fetchFriendProfile(friendId);
                        EventBroadcaster.broadcastFriendAccepted(zaloId, {
                            userId: friendId,
                            displayName,
                            avatar,
                            phoneNumber: phone,
                        });
                    }
                    return;
                }

                // ── FriendEventType.REMOVE (1) - Friend removed ──────────────────
                if (eventType === 1 && d) {
                    const friendId: string = typeof d === 'string' ? d : (d.fromUid || d.uid || '');
                    if (friendId) {
                        EventBroadcaster.broadcastFriendRemoved(zaloId, friendId);
                    }
                    return;
                }

                // ── FriendEventType.REJECT_REQUEST (4) / UNDO_REQUEST (3) ──────
                if ((eventType === 4 || eventType === 3) && d && typeof d === 'object') {
                    const friendId = isSelf
                        ? resolveFriendUserId(d, 'to')
                        : resolveFriendUserId(d, 'from');
                    if (friendId) {
                        const direction: 'received' | 'sent' = eventType === 4
                            ? (isSelf ? 'received' : 'sent')
                            : (isSelf ? 'sent' : 'received');
                        const reason = eventType === 4
                            ? (isSelf ? 'rejected_by_me' : 'rejected_by_them')
                            : (isSelf ? 'cancelled_by_me' : 'cancelled_by_them');
                        EventBroadcaster.broadcastFriendRequestRemoved(zaloId, {
                            userId: friendId,
                            direction,
                            reason,
                        });
                    }
                    return;
                }

                // ── Other types: SEEN(5), BLOCK(6), UNBLOCK(7), etc. ────────────
                // Just log - no user-facing notification needed
                Logger.log(`[ZaloLoginHelper] friend_event type=${eventType} (no action needed)`);
            } catch (error: any) {
                Logger.error(`[ZaloLoginHelper] friend_event error: ${error.message}`);
            }
        });

        // ── Reconnect the websocket like Zalo Web (zca-js retryOnClose, zca-js#386) ──────────────────────────────
        // Zalo PC logging in / out makes Zalo close this session's connection. zca-js reconnects right away on the same session, according to the code
        // closed + the number of attempts Zalo configures; only when zca-js stops retrying ("closed") or after ZCA_RETRY_WATCHDOG_MS is exceeded does it log in again
        // the whole session with cookies, as before. A listener that is no longer used (disconnected, account deleted, replaced by a new session) must not
        // reconnect by itself (zaloListenerRetry.ts).
        const isCurrentListener = () => ConnectionManager.getConnection(zaloId) === connection;
        const retryGuard = installZaloListenerRetryGuard(listener, {
            allowRetry: () => !ZaloLoginHelper.removedAccounts.has(zaloId) && isCurrentListener(),
            onBlocked: () => Logger.log(`[ZaloLoginHelper] ${zaloId} listener cũ - bỏ lượt tự nối lại`),
        });
        let retryWatchdog: ReturnType<typeof setTimeout> | null = null;
        const clearRetryWatchdog = () => {
            if (retryWatchdog) clearTimeout(retryWatchdog);
            retryWatchdog = null;
        };

        listener.on("connected", () => {
            clearRetryWatchdog();
            // The old listener can still connect (it was just replaced by a new session / disconnected / account deleted): close it so messages are not received twice
            if (!isCurrentListener()) {
                Logger.log(`[ZaloLoginHelper] ${zaloId} listener cũ vừa nối lại - đóng`);
                try { listener.stop(); } catch {}
                return;
            }
            retryGuard.resetRetryBudget();
            Logger.log(`[ZaloLoginHelper] ${zaloId} ✅ Connected`);
            ConnectionManager.setConnected(zaloId, true);
            DatabaseService.getInstance().setListenerActive(zaloId, true);
            EventBroadcaster.broadcastConnected(zaloId, { zaloId, send2meId });
        });

        // Each listener only cleans up and schedules one re-login ("disconnected" then "closed", or when reconnecting takes too long)
        let tornDown = false;
        const handleDisconnection = (eventType: string, code: CloseReason, reason: string) => {
            Logger.warn(`[ZaloLoginHelper] ${zaloId} ${eventType} - Code: ${code}, Reason: ${reason}`);
            if (tornDown) return;

            const currentConnection = ConnectionManager.getConnection(zaloId);
            if (currentConnection && currentConnection !== connection) {
                // The connection was replaced by a fresh login (QR/cookies) while the old listener was still running
                // → the old listener is closing and does not reconnect; the new connection is working (its state is not changed)
                Logger.log(`[ZaloLoginHelper] ${zaloId} stale connection closed (replaced by newer) - skipping reconnect`);
                return;
            }
            tornDown = true;
            ConnectionManager.setConnected(zaloId, false);
            ConnectionManager.setListenerStarted(zaloId, false);

            EventBroadcaster.broadcastDisconnected(zaloId, `${eventType} - ${CloseReason[code] || code}`);

            if (!currentConnection) {
                // Actively disconnected (Disconnect, log out, delete the account): does not log in again by itself. Previously it still scheduled
                // a re-login after 5 s, so "Ngắt kết nối" (Disconnect) did not hold.
                Logger.log(`[ZaloLoginHelper] ${zaloId} connection removed - skipping reconnect`);
                return;
            }
            ConnectionManager.removeConnection(zaloId);

            // ── Auto-reconnect ────────────────────────────────────────────────
            // Some CloseReason values mean the token is no longer valid → do not retry
            // For now, retry all of them to be safe
            const fatalCodes = new Set([]);
            if (fatalCodes.has(code)) {
                Logger.warn(`[ZaloLoginHelper] ${zaloId} fatal disconnect (${CloseReason[code]}) - marking listener_active=0`);
                DatabaseService.getInstance().setListenerActive(zaloId, false);
                EventBroadcaster.broadcastListenerDead(zaloId, `fatal_${CloseReason[code] || code}`);
                return;
            }

            // If the account was deleted on purpose → do not reconnect
            if (ZaloLoginHelper.removedAccounts.has(zaloId)) {
                Logger.log(`[ZaloLoginHelper] ${zaloId} was removed - skipping reconnect`);
                ZaloLoginHelper.removedAccounts.delete(zaloId);
                return;
            }


            ZaloLoginHelper.scheduleReconnect(zaloId, connection.auth, 0);
        };

        listener.on("disconnected", (code: CloseReason, reason: string) => {
            // zca-js just lost the connection: codes that can be retried reconnect by themselves after a few seconds, otherwise "closed" is emitted right after this
            Logger.warn(`[ZaloLoginHelper] ${zaloId} disconnected - Code: ${code}, Reason: ${reason}`);
            if (tornDown || !isCurrentListener()) return;
            ConnectionManager.setConnected(zaloId, false);
            EventBroadcaster.broadcastDisconnected(zaloId, `reconnecting - ${CloseReason[code] || code}`);
            clearRetryWatchdog();
            retryWatchdog = setTimeout(() => {
                retryWatchdog = null;
                if (tornDown || !isCurrentListener() || ConnectionManager.isConnected(zaloId)) return;
                Logger.warn(`[ZaloLoginHelper] ${zaloId} chưa tự nối lại sau ${ZCA_RETRY_WATCHDOG_MS / 1000}s - đăng nhập lại phiên`);
                handleDisconnection('retry_timeout', code, reason);
                try { listener.stop(); } catch {}
            }, ZCA_RETRY_WATCHDOG_MS);
        });

        listener.on("closed", (code: CloseReason, reason: string) => {
            clearRetryWatchdog();
            handleDisconnection('closed', code, reason);
        });

        listener.on("error", (error: any) => {
            Logger.error(`[ZaloLoginHelper] ${zaloId} error: ${error?.message || error}`);
        });

        // Sync messages from the phone: API pullMobile/znoise + control event "syncmsgmb"
        MobileSyncService.getInstance().attachToApi(zaloId, connection.api);
        // Read on the phone / Zalo PC: cmd 504 / 524 (zca-js does not emit an event yet) → clear the unread count in Deplao
        attachZaloReadElsewhere(zaloId, connection.api, (items) => EventBroadcaster.broadcastZaloReadElsewhere(zaloId, items));

        listener.start({ retryOnClose: true });
        ConnectionManager.setListenerStarted(zaloId, true);
        Logger.log(`[ZaloLoginHelper] ${zaloId} 🎧 Listener started (tự nối lại: ${describeZaloSocketRetry(connection.api)})`);
    }
}

// Register the group cache invalidate callback with EventBroadcaster
// (avoids a circular import: EventBroadcaster does not import ZaloLoginHelper)
registerGroupCacheInvalidator((zaloId: string, groupId: string) => {
    ZaloLoginHelper.invalidateGroupCache(zaloId, groupId);
});

export default ZaloLoginHelper;
