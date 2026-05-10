import { API, CloseReason, Credentials, LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";
import ConnectionManager from "./ConnectionManager";
import Logger from "./Logger";
import EventBroadcaster, { registerGroupCacheInvalidator } from "../services/EventBroadcaster";
import DatabaseService from "../services/DatabaseService";
import * as fs from "fs";
import { imageSize } from "image-size";
import { extractUserProfile } from "./profileUtils";

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_BASE_MS = 5000; // 5s base, exponential backoff

class ZaloLoginHelper {

    constructor() {}

    private createZaloConfig(options: any = {}) {
        return {
            selfListen: options.selfListen !== undefined ? options.selfListen : true,
            checkUpdate: options.checkUpdate !== undefined ? options.checkUpdate : false,
            logging: options.logging !== undefined ? options.logging : false,
            /**
             * imageMetadataGetter: bắt buộc để uploadAttachment với ảnh (jpg/png/webp/gif) hoạt động.
             * Dùng image-size để đọc width/height và fs.stat để lấy size.
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
    }

    /**
     * Đăng nhập QR Code
     */
    public async loginQR(tempId: string): Promise<void> {
        const zalo = new Zalo(this.createZaloConfig({ selfListen: true }));
        let account = { avatar: '', displayName: '' };
        let abortFn: (() => unknown) | null = null;

        // Lưu abort function để có thể cancel từ bên ngoài
        ZaloLoginHelper.activeQRAbortFns.set(tempId, () => { abortFn?.(); });

        const api = await zalo.loginQR({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        }, (res) => {
            console.log(`[ZaloLoginHelper] loginQR event type: ${res.type}`, JSON.stringify((res as any).data || {}).substring(0, 100));

            if (res.type === LoginQRCallbackEventType.QRCodeGenerated) {
                // Lưu abort function từ actions
                abortFn = (res as any).actions?.abort || null;

                // Field thực tế là data.image (raw base64, không có prefix)
                const raw: string = (res as any).data?.image || (res as any).data?.qrData || '';
                const qrDataUrl = raw
                    ? (raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`)
                    : '';

                console.log(`[ZaloLoginHelper] QR generated, image length: ${raw.length}, tempId: ${tempId}`);
                EventBroadcaster.broadcastQRUpdate(tempId, qrDataUrl, 'waiting');
            }

            if (res.type === LoginQRCallbackEventType.QRCodeExpired) {
                console.log(`[ZaloLoginHelper] QR expired for tempId: ${tempId}`);
                EventBroadcaster.broadcastQRUpdate(tempId, '', 'expired');
            }

            if (res.type === LoginQRCallbackEventType.QRCodeDeclined) {
                console.log(`[ZaloLoginHelper] QR declined for tempId: ${tempId}`);
                EventBroadcaster.broadcastQRUpdate(tempId, '', 'declined');
            }

            if (res.type === LoginQRCallbackEventType.QRCodeScanned) {
                account.avatar = (res as any).data?.avatar || '';
                account.displayName = (res as any).data?.display_name || '';
                console.log(`[ZaloLoginHelper] QR scanned: ${account.displayName}`);
                EventBroadcaster.broadcastQRUpdate(tempId, '', 'scanned');
            }
        });

        // Cleanup
        ZaloLoginHelper.activeQRAbortFns.delete(tempId);

        const context = api.getContext();
        const zaloId = api.getOwnId();

        if (!zaloId || !context) {
            EventBroadcaster.broadcastQRUpdate(tempId, '', 'error');
            throw new Error("Đăng nhập QR thất bại");
        }

        const cookiesJson = JSON.stringify(context.cookie.serializeSync());
        const auth = {
            cookies: cookiesJson,
            imei: context.imei,
            userAgent: context.userAgent,
        };

        // 1. Kiểm tra trước nếu đây là tài khoản mới (chưa có trong DB)
        const isNewAccount = !DatabaseService.getInstance().hasAccount(zaloId);

        // 2. Lưu account vào DB TRƯỚC khi broadcast success
        //    → khi renderer nhận 'success' và gọi getAccounts() sẽ thấy account ngay
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
            Logger.log(`[ZaloLoginHelper] Account ${zaloId} saved to DB`);
        } catch (dbErr: any) {
            Logger.error(`[ZaloLoginHelper] Failed to save account: ${dbErr.message}`);
        }

        // 3. Kết nối và start listener
        await this.connectZaloUser(auth, api);

        // 4. Fetch phone + bizPkg từ API rồi cập nhật DB — TRƯỚC khi broadcast success
        //    Để khi renderer + loginIpc gọi getAccounts/registerPage → đã có đủ phone
        try {
            const accountInfo = await api.fetchAccountInfo();
            const phone: string = accountInfo?.profile?.phoneNumber || (accountInfo as any)?.phoneNumber || '';
            const bizPkgId: number = accountInfo?.profile?.bizPkg?.pkgId ?? (accountInfo as any)?.bizPkg?.pkgId ?? 0;
            const isBusiness = bizPkgId > 0 ? 1 : 0;
            DatabaseService.getInstance().updateAccountInfo(zaloId, phone, isBusiness);
            if (phone) savedPhone = phone;
            Logger.log(`[ZaloLoginHelper] Updated ${zaloId}: phone=${phone}, isBusiness=${isBusiness}`);
        } catch (err: any) {
            Logger.warn(`[ZaloLoginHelper] fetchAccountInfo after QR failed: ${err.message}`);
        }

        // 5. Broadcast success SAU khi đã save + connect + fetch phone
        EventBroadcaster.broadcastQRUpdate(tempId, '', 'success');
        Logger.log(`[ZaloLoginHelper] QR Login success: ${zaloId}`);

        // 6. Callback sau QR login thành công
        if (ZaloLoginHelper.onQRSuccessCallback) {
            try { ZaloLoginHelper.onQRSuccessCallback(zaloId, isNewAccount); } catch {}
        }

        // 7. Nếu là tài khoản mới → fetch toàn bộ bạn bè + nhóm + thành viên ngầm
        if (isNewAccount) {
            ZaloLoginHelper.fetchAllFriendsInBackground(zaloId, api);
            ZaloLoginHelper.fetchAllGroupsInBackground(zaloId, api);
        }
    }

    // Map lưu các abort functions cho QR đang chờ
    private static activeQRAbortFns: Map<string, () => void> = new Map();
    // Set lưu các group IDs đã fetch info để tránh gọi lại
    private static fetchedGroupIds: Set<string> = new Set();
    // Đếm số lần reconnect đang thử cho mỗi account
    private static reconnectAttempts: Map<string, number> = new Map();
    // Timer handles để có thể cancel
    private static reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    // Set lưu các account đã bị xóa chủ động — KHÔNG reconnect
    private static removedAccounts: Set<string> = new Set();
    /** Callback được gọi khi QR login thành công */
    private static onQRSuccessCallback: ((zaloId: string, isNewAccount: boolean) => void) | null = null;

    public static setQRSuccessCallback(cb: (zaloId: string, isNewAccount: boolean) => void): void {
        ZaloLoginHelper.onQRSuccessCallback = cb;
    }

    /** Callback được gọi sau khi fetch phone/bizPkg hoàn tất — dùng để sync phone lên Sheets */
    private static onProfileReadyCallback: ((zaloId: string, name: string, phone: string) => void) | null = null;

    public static setProfileReadyCallback(cb: (zaloId: string, name: string, phone: string) => void): void {
        ZaloLoginHelper.onProfileReadyCallback = cb;
    }

    /** Đánh dấu account đã bị xóa — ngăn reconnect khi listener ngắt kết nối */
    public static markRemoved(zaloId: string): void {
        ZaloLoginHelper.removedAccounts.add(zaloId);
        ZaloLoginHelper.cancelReconnect(zaloId);
    }

    /** Bỏ đánh dấu (dùng khi account được thêm lại) */
    public static unmarkRemoved(zaloId: string): void {
        ZaloLoginHelper.removedAccounts.delete(zaloId);
    }

    /** Abort QR login đang chờ */
    public static abortQR(tempId: string): void {
        const fn = ZaloLoginHelper.activeQRAbortFns.get(tempId);
        if (fn) { fn(); ZaloLoginHelper.activeQRAbortFns.delete(tempId); }
    }

    /**
     * Lên lịch reconnect với exponential backoff.
     * attempt=0 → delay=5s, 1→10s, 2→20s, 3→40s, 4→80s → rồi đánh dấu dead.
     */
    public static scheduleReconnect(zaloId: string, auth: any, attempt: number): void {
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            Logger.error(`[ZaloLoginHelper] ${zaloId} max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — marking listener_active=0`);
            DatabaseService.getInstance().setListenerActive(zaloId, false);
            EventBroadcaster.broadcastListenerDead(zaloId, 'max_retries');
            ZaloLoginHelper.reconnectAttempts.delete(zaloId);
            return;
        }


        const delay = RECONNECT_DELAY_BASE_MS * Math.pow(2, attempt);
        Logger.log(`[ZaloLoginHelper] ${zaloId} scheduling reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

        // Cancel bất kỳ timer pending nào
        const existing = ZaloLoginHelper.reconnectTimers.get(zaloId);
        if (existing) clearTimeout(existing);

        ZaloLoginHelper.reconnectAttempts.set(zaloId, attempt);

        const timer = setTimeout(async () => {
            ZaloLoginHelper.reconnectTimers.delete(zaloId);

            // Nếu listener đã được khôi phục trong khi chờ (ví dụ: user đăng nhập lại QR)
            // → không cần reconnect nữa
            if (ConnectionManager.isListenerStarted(zaloId)) {
                Logger.log(`[ZaloLoginHelper] ${zaloId} already reconnected while waiting — cancelling attempt ${attempt + 1}`);
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
                    // connected event sẽ được broadcast bởi setupEventListeners
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

    /** Huỷ reconnect timer đang chờ (khi user disconnect thủ công) */
    public static cancelReconnect(zaloId: string): void {
        const timer = ZaloLoginHelper.reconnectTimers.get(zaloId);
        if (timer) { clearTimeout(timer); ZaloLoginHelper.reconnectTimers.delete(zaloId); }
        ZaloLoginHelper.reconnectAttempts.delete(zaloId);
    }

    /** Xóa cache fetchedGroupIds cho 1 nhóm để cho phép re-fetch khi có group_event thay đổi */
    public static invalidateGroupCache(zaloId: string, groupId: string): void {
        const cacheKey = `${zaloId}_${groupId}`;
        ZaloLoginHelper.fetchedGroupIds.delete(cacheKey);
        Logger.log(`[ZaloLoginHelper] Invalidated group cache for ${groupId}`);
    }

    /**
     * Fetch group info in background if not already fetched.
     * Updates DB contact with proper group name & avatar, and saves members.
     * Chỉ gọi API nếu:
     * 1. Chưa có trong fetchedGroupIds (session cache)
     * 2. Chưa có tên thực trong DB
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

            // Kiểm tra DB bằng single-row lookup thay vì load toàn bộ contacts
            const hasRealName = existing && existing.display_name &&
                existing.display_name !== groupId && !existing.display_name.match(/^\d+$/);

            const hasMembers = Array.isArray(existingMembers) && existingMembers.length > 0;

            // Nếu đã có đầy đủ cả tên lẫn members → đánh dấu và bỏ qua
            if (hasRealName && hasMembers) {
                ZaloLoginHelper.fetchedGroupIds.add(cacheKey);
                return;
            }

            ZaloLoginHelper.fetchedGroupIds.add(cacheKey); // Mark before fetch to prevent parallel calls

            const res = await api.getGroupInfo(groupId);
            const groupData = res?.changed_groups?.[groupId] || res?.gridInfoMap?.[groupId];
            if (!groupData) return;

            const name: string = groupData.name || groupData.nameChanged || groupId;
            const avatar: string = groupData.avt || groupData.fullAvt || '';
            const creatorId: string = groupData.creatorId || groupData.creator || '';
            const adminIds: string[] = groupData.adminIds || groupData.subAdmins || [];

            // Cập nhật tên nhóm nếu chưa có — luôn write vào boss DB
            if (!hasRealName) {
                EventBroadcaster.runOnBossDb((bossDb) => bossDb.updateContactProfile(zaloId, groupId, name, avatar));
                Logger.log(`[ZaloLoginHelper] ✅ Fetched group info for ${groupId}: "${name}"`);
                EventBroadcaster.broadcastGroupInfoUpdate(zaloId, groupId, name, avatar, groupData);
            }

            // Lưu members nếu chưa có — luôn write vào boss DB
            if (!hasMembers) {
                const rawMembers: any[] = groupData.memVerList || groupData.memberList ||
                    groupData.members || groupData.currentMems || [];
                if (rawMembers.length > 0) {
                    // memVerList có thể là array of strings "uid_version" hoặc array of objects
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
     * Fetch tất cả nhóm trong nền khi tài khoản đăng nhập lần đầu.
     * Gọi getAllGroups → lấy danh sách groupId → fetch info + members từng nhóm.
     * Xử lý song song theo batch (concurrency=5) để giảm thời gian chờ.
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
                // Delay nhỏ giữa các batch để không spam API
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
     * Fetch toàn bộ bạn bè trong nền khi tài khoản đăng nhập lần đầu.
     * Gọi getAllFriends → normalize → lưu vào bảng friends + cập nhật contacts.
     * Dùng batch insert để tránh N lần disk write (10k bạn = 1 disk write thay vì 10k).
     */
    private static async fetchAllFriendsInBackground(zaloId: string, api: any): Promise<void> {
        try {
            Logger.log(`[ZaloLoginHelper] 👥 [FirstLogin] Fetching all friends for new account ${zaloId}...`);
            const db = DatabaseService.getInstance();

            const res = await api.getAllFriends();
            // API trả về User[] hoặc object map
            let list: any[] = [];
            if (Array.isArray(res)) list = res;
            else if (res && typeof res === 'object') list = Object.values(res);

            if (list.length === 0) {
                Logger.log(`[ZaloLoginHelper] [FirstLogin] No friends found for ${zaloId}`);
                return;
            }

            // Normalize và lưu vào bảng friends (batch — single disk write)
            const normalized = list.map((f: any) => ({
                userId: f.userId || f.uid || '',
                displayName: f.displayName || f.zaloName || f.display_name || '',
                avatar: f.avatar || '',
                phoneNumber: f.phoneNumber || f.phone || '',
            })).filter((f: any) => f.userId);

            if (normalized.length > 0) {
                db.saveFriends(zaloId, normalized);
                Logger.log(`[ZaloLoginHelper] [FirstLogin] Saved ${normalized.length} friends to friends table`);

                // Batch upsert contacts (single disk write thay vì N lần)
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
     * Đăng nhập bằng Cookies/IMEI
     */
    public async loginCookies(imei: string, cookies: string, userAgent: string): Promise<any> {
        const zalo = new Zalo(this.createZaloConfig({ selfListen: true }));

        const credentials: Partial<Credentials> = {
            cookie: JSON.parse(cookies),
            imei,
            userAgent,
        };

        try {
            const api = await zalo.login(credentials as Credentials);
            const zaloId = api.getOwnId();

            if (!zaloId) throw new Error("Login thất bại: không lấy được zaloId");

            const isNewAccount = !DatabaseService.getInstance().hasAccount(zaloId);
            const accountInfo = await api.fetchAccountInfo();

            await this.connectZaloUser({ imei, cookies, userAgent }, api);

            // Nếu là tài khoản mới → fetch toàn bộ bạn bè + nhóm + thành viên ngầm
            if (isNewAccount) {
                ZaloLoginHelper.fetchAllFriendsInBackground(zaloId, api);
                ZaloLoginHelper.fetchAllGroupsInBackground(zaloId, api);
            }

            Logger.log(`[ZaloLoginHelper] Cookies login success: ${zaloId}`);
            return accountInfo;
        } catch (error: any) {
            Logger.error(`[ZaloLoginHelper] loginCookies failed: ${error.message}`);
            throw new Error(`Đăng nhập thất bại: ${error.message}`);
        }
    }

    /**
     * Kết nối user, thiết lập listeners
     */
    public async connectZaloUser(
        auth: { cookies: string; imei: string; userAgent: string },
        api?: API
    ): Promise<boolean> {
        try {
            Logger.log(`[ZaloLoginHelper] connectZaloUser starting...`);

            // Nếu đây là fresh login (api được cung cấp từ QR/cookies),
            // huỷ ngay reconnect timer đang chờ để tránh race condition
            if (api) {
                const freshZaloId = api.getOwnId();
                if (freshZaloId) ZaloLoginHelper.cancelReconnect(freshZaloId);
            }

            const connection = await ConnectionManager.getOrCreateConnection(auth, true, api);
            const zaloId = connection.api.getOwnId();

            // Bỏ đánh dấu "removed" nếu account được kết nối lại
            ZaloLoginHelper.removedAccounts.delete(zaloId);

            if (ConnectionManager.isListenerStarted(zaloId)) {
                Logger.log(`[ZaloLoginHelper] ${zaloId} already has active listener`);
                return true;
            }

            this.setupEventListeners(zaloId, connection);
            return true;
        } catch (error: any) {
            Logger.error(`[ZaloLoginHelper] connectZaloUser failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Ngắt kết nối user
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
     * Ngắt kết nối tất cả
     */
    public async disconnectAllUsers(): Promise<boolean> {
        const connections = ConnectionManager.getAllConnections();
        for (const zaloId of connections.keys()) {
            await this.disconnectUser(zaloId);
        }
        return true;
    }

    /**
     * Đăng nhập Zalo (internal)
     */
    public async loginZalo(
        auth: { cookies: string; imei: string; userAgent: string }
    ): Promise<API> {
        const zalo = new Zalo(this.createZaloConfig({ selfListen: true }));

        let cookieParsed: any;
        try {
            cookieParsed = JSON.parse(auth.cookies);
        } catch {
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

    public async requestOldMessages(auth: { cookies: string; imei: string; userAgent: string }): Promise<boolean> {
        try {
            const connection = await ConnectionManager.getOrCreateConnection(auth, true);
            const zaloId = connection.api.getOwnId();

            if (ConnectionManager.isConnected(zaloId)) {
                connection.api.listener.requestOldMessages(ThreadType.User, null);
                connection.api.listener.requestOldMessages(ThreadType.Group, null);
                return true;
            }
            return false;
        } catch (error: any) {
            Logger.error(`[ZaloLoginHelper] requestOldMessages failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Thiết lập event listeners và broadcast qua EventBroadcaster
     */
    private setupEventListeners(zaloId: string, connection: any): void {
        const { listener } = connection;

        listener.on("message", async (message: any) => {
            try {
                // DEBUG LOG: xem cấu trúc message thực tế từ zca-js (main process)
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

                // ─── Xử lý chat.delete (xoá tin nhắn phía tôi) ─────────────────
                const msgType = message.data?.msgType as string;
                if (msgType === 'chat.delete') {
                    const threadId = message.threadId || '';
                    const contentArr: any[] = Array.isArray(message.data?.content) ? message.data.content : [];
                    // Lấy globalDelMsgId từ mảng delete items
                    const msgIds: string[] = contentArr
                        .map((item: any) => String(item.globalDelMsgId || item.clientDelMsgId || ''))
                        .filter(Boolean);
                    Logger.log(`[ZaloLoginHelper] 🗑️ chat.delete: thread=${threadId} msgIds=${JSON.stringify(msgIds)}`);
                    EventBroadcaster.broadcastDeleteMessages(zaloId, msgIds, threadId);
                    return;
                }

                // ─── Xử lý chat.ecard (reminder notification) ─────────────────
                if (msgType === 'chat.ecard') {
                    const content = message.data?.content;
                    if (content && typeof content === 'object') {
                        const params = typeof content.params === 'string' ? (() => {
                            try { return JSON.parse(content.params); } catch { return null; }
                        })() : content.params;

                        // Kiểm tra xem có phải reminder không
                        if (params?.actions?.[0]?.actionId === 'action.open.reminder') {
                            Logger.log(`[ZaloLoginHelper] ⏰ Reminder notification: thread=${message.threadId} title="${content.title}"`);
                            EventBroadcaster.broadcastReminderNotification(zaloId, message.threadId || '', msgType, content);
                        }
                    }
                }

                message.zaloId = zaloId;
                await EventBroadcaster.broadcastMessage(zaloId, message);

                // ─── For group messages: fetch group info in background if not cached ─
                if (message.type === 1) {
                    const groupId = message.threadId || '';
                    if (groupId) {
                        ZaloLoginHelper.fetchGroupInfoIfMissing(zaloId, groupId, connection.api);
                    }
                }
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
                // DEBUG: log toàn bộ reaction object
                Logger.log(`[ZaloLoginHelper] 🎭 RAW reaction: ${JSON.stringify({
                    top_keys: Object.keys(reaction),
                    threadId: reaction.threadId,
                    msgId: reaction.msgId || reaction.data?.msgId,
                    uidFrom: reaction.uidFrom || reaction.data?.uidFrom,
                    content: reaction.content || reaction.data?.content,
                    rIcon: reaction.rIcon || reaction.data?.rIcon || reaction.data?.content?.rIcon,
                    full: reaction,
                })}`);

                // ─── Kiểm tra xem người gửi reaction có trong hệ thống chưa ──────
                const rData = reaction.data || {};
                const uidFrom = String(rData.uidFrom || reaction.uidFrom || '');
                const threadId: string = reaction.threadId || rData.idTo || rData.threadId || '';
                const isGroup: boolean = !!reaction.isGroup;

                if (uidFrom && uidFrom !== zaloId) {
                    const db = DatabaseService.getInstance();
                    let isKnown = false;

                    // Kiểm tra bảng thành viên nhóm trước
                    if (isGroup && threadId) {
                        const members = db.getGroupMembers(zaloId, threadId);
                        isKnown = members.some((m: any) => m.member_id === uidFrom);
                    }
                    // Kiểm tra bảng contacts nếu chưa tìm thấy
                    if (!isKnown) {
                        const contacts = db.getContacts(zaloId);
                        isKnown = contacts.some((c: any) => c.contact_id === uidFrom);
                    }

                    if (!isKnown) {
                        // Người dùng chưa có trong hệ thống → fetch thông tin và lưu vào DB
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
                //   undo.data        — TUndo object
                //   undo.data.content — TUndoContent { globalMsgId, cliMsgId, deleteMsg, srcId, destId }
                //   undo.threadId    — thread containing the recalled message
                //   undo.isSelf      — true nếu mình thu hồi
                //   undo.isGroup     — true nếu là group
                //
                // ID cần dùng: content.globalMsgId (ID tin nhắn bị thu hồi)
                // KHÔNG dùng undo.data.msgId (đó là ID của action undo, không phải tin nhắn gốc)

                const d: any = undo.data || undo;
                const content = d.content || {};
                // globalMsgId là ID số lớn → chuyển sang string
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

        listener.on("seen", (data: any) => {
            Logger.log(`[ZaloLoginHelper] 📩 RAW seen event: ${JSON.stringify(data)}`);
            try {
                EventBroadcaster.broadcastSeen(zaloId, data);
            } catch {}
        });

        listener.on("old_messages", async (messages: any[]) => {
            Logger.log(`[ZaloLoginHelper] 📩 RAW old_messages event: ${messages.length} messages`);
            try {
                for (const message of messages) {
                    message.zaloId = zaloId;
                    await EventBroadcaster.broadcastMessage(zaloId, message, { silent: true });
                }
            } catch (error: any) {
                Logger.error(`[ZaloLoginHelper] old_messages error: ${error.message}`);
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

                // ── FriendEventType.REQUEST (2) — req_v2 event, direction depends on isSelf ──
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

                // ── FriendEventType.ADD(0) — Đã trở thành bạn bè ─────────────────
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

                // ── FriendEventType.REMOVE (1) — Friend removed ──────────────────
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
                // Just log — no user-facing notification needed
                Logger.log(`[ZaloLoginHelper] friend_event type=${eventType} (no action needed)`);
            } catch (error: any) {
                Logger.error(`[ZaloLoginHelper] friend_event error: ${error.message}`);
            }
        });

        listener.on("connected", () => {
            Logger.log(`[ZaloLoginHelper] ${zaloId} ✅ Connected`);
            ConnectionManager.setConnected(zaloId, true);
            DatabaseService.getInstance().setListenerActive(zaloId, true);
            EventBroadcaster.broadcastConnected(zaloId, { zaloId });
        });

        const handleDisconnection = (eventType: string, code: CloseReason, reason: string) => {
            Logger.warn(`[ZaloLoginHelper] ${zaloId} ${eventType} - Code: ${code}, Reason: ${reason}`);
            ConnectionManager.setConnected(zaloId, false);
            ConnectionManager.setListenerStarted(zaloId, false);

            EventBroadcaster.broadcastDisconnected(zaloId, `${eventType} - ${CloseReason[code] || code}`);

            const currentConnection = ConnectionManager.getConnection(zaloId);
            if (currentConnection && currentConnection === connection) {
                ConnectionManager.removeConnection(zaloId);
            } else if (currentConnection && currentConnection !== connection) {
                // Connection bị thay thế bởi fresh login (QR/cookies) trong khi listener cũ vẫn chạy
                // → listener cũ đang đóng, không reconnect — connection mới đang hoạt động
                Logger.log(`[ZaloLoginHelper] ${zaloId} stale connection closed (replaced by newer) — skipping reconnect`);
                return;
            }

            // ── Auto-reconnect ────────────────────────────────────────────────
            // Một số CloseReason cho biết token không còn hiệu lực → không retry
            // Hiện tại thì retry tất cả cho chắc
            const fatalCodes = new Set([]);
            if (fatalCodes.has(code)) {
                Logger.warn(`[ZaloLoginHelper] ${zaloId} fatal disconnect (${CloseReason[code]}) — marking listener_active=0`);
                DatabaseService.getInstance().setListenerActive(zaloId, false);
                EventBroadcaster.broadcastListenerDead(zaloId, `fatal_${CloseReason[code] || code}`);
                return;
            }

            // Nếu account đã bị xóa chủ động → không reconnect
            if (ZaloLoginHelper.removedAccounts.has(zaloId)) {
                Logger.log(`[ZaloLoginHelper] ${zaloId} was removed — skipping reconnect`);
                ZaloLoginHelper.removedAccounts.delete(zaloId);
                return;
            }


            ZaloLoginHelper.scheduleReconnect(zaloId, connection.auth, 0);
        };

        listener.on("disconnected", (code: CloseReason, reason: string) => {
            handleDisconnection('disconnected', code, reason);
        });

        listener.on("closed", (code: CloseReason, reason: string) => {
            handleDisconnection('closed', code, reason);
        });

        listener.on("error", (error: any) => {
            Logger.error(`[ZaloLoginHelper] ${zaloId} error: ${error?.message || error}`);
        });

        listener.start();
        ConnectionManager.setListenerStarted(zaloId, true);
        Logger.log(`[ZaloLoginHelper] ${zaloId} 🎧 Listener started`);
    }
}

// Đăng ký callback invalidate group cache vào EventBroadcaster
// (tránh circular import: EventBroadcaster không import ZaloLoginHelper)
registerGroupCacheInvalidator((zaloId: string, groupId: string) => {
    ZaloLoginHelper.invalidateGroupCache(zaloId, groupId);
});

export default ZaloLoginHelper;
