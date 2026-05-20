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
const zca_js_1 = require("zca-js");
const ConnectionManager_1 = __importDefault(require("./ConnectionManager"));
const Logger_1 = __importDefault(require("./Logger"));
const EventBroadcaster_1 = __importStar(require("../services/EventBroadcaster"));
const DatabaseService_1 = __importDefault(require("../services/DatabaseService"));
const fs = __importStar(require("fs"));
const image_size_1 = require("image-size");
const profileUtils_1 = require("./profileUtils");
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_BASE_MS = 5000; // 5s base, exponential backoff
class ZaloLoginHelper {
    constructor() { }
    createZaloConfig(options = {}) {
        return {
            selfListen: options.selfListen !== undefined ? options.selfListen : true,
            checkUpdate: options.checkUpdate !== undefined ? options.checkUpdate : false,
            logging: options.logging !== undefined ? options.logging : false,
            /**
             * imageMetadataGetter: bắt buộc để uploadAttachment với ảnh (jpg/png/webp/gif) hoạt động.
             * Dùng image-size để đọc width/height và fs.stat để lấy size.
             */
            imageMetadataGetter: async (filePath) => {
                try {
                    const stat = fs.statSync(filePath);
                    const buf = fs.readFileSync(filePath);
                    const dim = (0, image_size_1.imageSize)(buf);
                    return {
                        width: dim.width ?? 0,
                        height: dim.height ?? 0,
                        size: stat.size,
                    };
                }
                catch (e) {
                    Logger_1.default.warn(`[ZaloLoginHelper] imageMetadataGetter error for ${filePath}: ${e.message}`);
                    return null;
                }
            },
        };
    }
    /**
     * Đăng nhập QR Code
     */
    async loginQR(tempId) {
        const zalo = new zca_js_1.Zalo(this.createZaloConfig({ selfListen: true }));
        let account = { avatar: '', displayName: '' };
        let abortFn = null;
        // Lưu abort function để có thể cancel từ bên ngoài
        ZaloLoginHelper.activeQRAbortFns.set(tempId, () => { abortFn?.(); });
        const api = await zalo.loginQR({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        }, (res) => {
            console.log(`[ZaloLoginHelper] loginQR event type: ${res.type}`, JSON.stringify(res.data || {}).substring(0, 100));
            if (res.type === zca_js_1.LoginQRCallbackEventType.QRCodeGenerated) {
                // Lưu abort function từ actions
                abortFn = res.actions?.abort || null;
                // Field thực tế là data.image (raw base64, không có prefix)
                const raw = res.data?.image || res.data?.qrData || '';
                const qrDataUrl = raw
                    ? (raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`)
                    : '';
                console.log(`[ZaloLoginHelper] QR generated, image length: ${raw.length}, tempId: ${tempId}`);
                EventBroadcaster_1.default.broadcastQRUpdate(tempId, qrDataUrl, 'waiting');
            }
            if (res.type === zca_js_1.LoginQRCallbackEventType.QRCodeExpired) {
                console.log(`[ZaloLoginHelper] QR expired for tempId: ${tempId}`);
                EventBroadcaster_1.default.broadcastQRUpdate(tempId, '', 'expired');
            }
            if (res.type === zca_js_1.LoginQRCallbackEventType.QRCodeDeclined) {
                console.log(`[ZaloLoginHelper] QR declined for tempId: ${tempId}`);
                EventBroadcaster_1.default.broadcastQRUpdate(tempId, '', 'declined');
            }
            if (res.type === zca_js_1.LoginQRCallbackEventType.QRCodeScanned) {
                account.avatar = res.data?.avatar || '';
                account.displayName = res.data?.display_name || '';
                console.log(`[ZaloLoginHelper] QR scanned: ${account.displayName}`);
                EventBroadcaster_1.default.broadcastQRUpdate(tempId, '', 'scanned');
            }
        });
        // Cleanup
        ZaloLoginHelper.activeQRAbortFns.delete(tempId);
        const context = api.getContext();
        const zaloId = api.getOwnId();
        if (!zaloId || !context) {
            EventBroadcaster_1.default.broadcastQRUpdate(tempId, '', 'error');
            throw new Error("Đăng nhập QR thất bại");
        }
        const cookiesJson = JSON.stringify(context.cookie.serializeSync());
        const auth = {
            cookies: cookiesJson,
            imei: context.imei,
            userAgent: context.userAgent,
        };
        // 1. Kiểm tra trước nếu đây là tài khoản mới (chưa có trong DB)
        const isNewAccount = !DatabaseService_1.default.getInstance().hasAccount(zaloId);
        // 2. Lưu account vào DB TRƯỚC khi broadcast success
        //    → khi renderer nhận 'success' và gọi getAccounts() sẽ thấy account ngay
        let savedPhone = account.phoneNumber || account.phone || '';
        try {
            DatabaseService_1.default.getInstance().saveAccount({
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
            Logger_1.default.log(`[ZaloLoginHelper] Account ${zaloId} saved to DB`);
        }
        catch (dbErr) {
            Logger_1.default.error(`[ZaloLoginHelper] Failed to save account: ${dbErr.message}`);
        }
        // 3. Kết nối và start listener
        await this.connectZaloUser(auth, api);
        // 4. Fetch phone + bizPkg từ API rồi cập nhật DB — TRƯỚC khi broadcast success
        //    Để khi renderer + loginIpc gọi getAccounts/registerPage → đã có đủ phone
        try {
            const accountInfo = await api.fetchAccountInfo();
            const phone = accountInfo?.profile?.phoneNumber || accountInfo?.phoneNumber || '';
            const bizPkgId = accountInfo?.profile?.bizPkg?.pkgId ?? accountInfo?.bizPkg?.pkgId ?? 0;
            const isBusiness = bizPkgId > 0 ? 1 : 0;
            DatabaseService_1.default.getInstance().updateAccountInfo(zaloId, phone, isBusiness);
            if (phone)
                savedPhone = phone;
            Logger_1.default.log(`[ZaloLoginHelper] Updated ${zaloId}: phone=${phone}, isBusiness=${isBusiness}`);
        }
        catch (err) {
            Logger_1.default.warn(`[ZaloLoginHelper] fetchAccountInfo after QR failed: ${err.message}`);
        }
        // 5. Broadcast success SAU khi đã save + connect + fetch phone
        EventBroadcaster_1.default.broadcastQRUpdate(tempId, '', 'success');
        Logger_1.default.log(`[ZaloLoginHelper] QR Login success: ${zaloId}`);
        // 6. Callback sau QR login thành công
        if (ZaloLoginHelper.onQRSuccessCallback) {
            try {
                ZaloLoginHelper.onQRSuccessCallback(zaloId, isNewAccount);
            }
            catch { }
        }
        // 7. Nếu là tài khoản mới → fetch toàn bộ bạn bè + nhóm + thành viên ngầm
        if (isNewAccount) {
            ZaloLoginHelper.fetchAllFriendsInBackground(zaloId, api);
            ZaloLoginHelper.fetchAllGroupsInBackground(zaloId, api);
        }
    }
    static setQRSuccessCallback(cb) {
        ZaloLoginHelper.onQRSuccessCallback = cb;
    }
    static setProfileReadyCallback(cb) {
        ZaloLoginHelper.onProfileReadyCallback = cb;
    }
    /** Đánh dấu account đã bị xóa — ngăn reconnect khi listener ngắt kết nối */
    static markRemoved(zaloId) {
        ZaloLoginHelper.removedAccounts.add(zaloId);
        ZaloLoginHelper.cancelReconnect(zaloId);
    }
    /** Bỏ đánh dấu (dùng khi account được thêm lại) */
    static unmarkRemoved(zaloId) {
        ZaloLoginHelper.removedAccounts.delete(zaloId);
    }
    /** Abort QR login đang chờ */
    static abortQR(tempId) {
        const fn = ZaloLoginHelper.activeQRAbortFns.get(tempId);
        if (fn) {
            fn();
            ZaloLoginHelper.activeQRAbortFns.delete(tempId);
        }
    }
    /**
     * Lên lịch reconnect với exponential backoff.
     * attempt=0 → delay=5s, 1→10s, 2→20s, 3→40s, 4→80s → rồi đánh dấu dead.
     */
    static scheduleReconnect(zaloId, auth, attempt) {
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
            Logger_1.default.error(`[ZaloLoginHelper] ${zaloId} max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — marking listener_active=0`);
            DatabaseService_1.default.getInstance().setListenerActive(zaloId, false);
            EventBroadcaster_1.default.broadcastListenerDead(zaloId, 'max_retries');
            ZaloLoginHelper.reconnectAttempts.delete(zaloId);
            return;
        }
        const delay = RECONNECT_DELAY_BASE_MS * Math.pow(2, attempt);
        Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} scheduling reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
        // Cancel bất kỳ timer pending nào
        const existing = ZaloLoginHelper.reconnectTimers.get(zaloId);
        if (existing)
            clearTimeout(existing);
        ZaloLoginHelper.reconnectAttempts.set(zaloId, attempt);
        const timer = setTimeout(async () => {
            ZaloLoginHelper.reconnectTimers.delete(zaloId);
            // Nếu listener đã được khôi phục trong khi chờ (ví dụ: user đăng nhập lại QR)
            // → không cần reconnect nữa
            if (ConnectionManager_1.default.isListenerStarted(zaloId)) {
                Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} already reconnected while waiting — cancelling attempt ${attempt + 1}`);
                ZaloLoginHelper.reconnectAttempts.delete(zaloId);
                return;
            }
            Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} attempting reconnect #${attempt + 1}...`);
            try {
                const helper = new ZaloLoginHelper();
                const success = await helper.connectZaloUser(auth);
                if (success) {
                    Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} ✅ reconnect #${attempt + 1} success`);
                    ZaloLoginHelper.reconnectAttempts.delete(zaloId);
                    DatabaseService_1.default.getInstance().setListenerActive(zaloId, true);
                    // connected event sẽ được broadcast bởi setupEventListeners
                }
                else {
                    ZaloLoginHelper.scheduleReconnect(zaloId, auth, attempt + 1);
                }
            }
            catch (err) {
                Logger_1.default.warn(`[ZaloLoginHelper] ${zaloId} reconnect #${attempt + 1} failed: ${err.message}`);
                ZaloLoginHelper.scheduleReconnect(zaloId, auth, attempt + 1);
            }
        }, delay);
        ZaloLoginHelper.reconnectTimers.set(zaloId, timer);
    }
    /** Huỷ reconnect timer đang chờ (khi user disconnect thủ công) */
    static cancelReconnect(zaloId) {
        const timer = ZaloLoginHelper.reconnectTimers.get(zaloId);
        if (timer) {
            clearTimeout(timer);
            ZaloLoginHelper.reconnectTimers.delete(zaloId);
        }
        ZaloLoginHelper.reconnectAttempts.delete(zaloId);
    }
    /** Xóa cache fetchedGroupIds cho 1 nhóm để cho phép re-fetch khi có group_event thay đổi */
    static invalidateGroupCache(zaloId, groupId) {
        const cacheKey = `${zaloId}_${groupId}`;
        ZaloLoginHelper.fetchedGroupIds.delete(cacheKey);
        Logger_1.default.log(`[ZaloLoginHelper] Invalidated group cache for ${groupId}`);
    }
    /**
     * Fetch group info in background if not already fetched.
     * Updates DB contact with proper group name & avatar, and saves members.
     * Chỉ gọi API nếu:
     * 1. Chưa có trong fetchedGroupIds (session cache)
     * 2. Chưa có tên thực trong DB
     */
    static async fetchGroupInfoIfMissing(zaloId, groupId, api) {
        const cacheKey = `${zaloId}_${groupId}`;
        if (ZaloLoginHelper.fetchedGroupIds.has(cacheKey))
            return;
        try {
            // Always read/write boss DB (cross-workspace safe)
            const db = DatabaseService_1.default.getInstance();
            let existing = null;
            let existingMembers = [];
            EventBroadcaster_1.default.runOnBossDb((bossDb) => {
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
            if (!groupData)
                return;
            const name = groupData.name || groupData.nameChanged || groupId;
            const avatar = groupData.avt || groupData.fullAvt || '';
            const creatorId = groupData.creatorId || groupData.creator || '';
            const adminIds = groupData.adminIds || groupData.subAdmins || [];
            // Cập nhật tên nhóm nếu chưa có — luôn write vào boss DB
            if (!hasRealName) {
                EventBroadcaster_1.default.runOnBossDb((bossDb) => bossDb.updateContactProfile(zaloId, groupId, name, avatar));
                Logger_1.default.log(`[ZaloLoginHelper] ✅ Fetched group info for ${groupId}: "${name}"`);
                EventBroadcaster_1.default.broadcastGroupInfoUpdate(zaloId, groupId, name, avatar, groupData);
            }
            // Lưu members nếu chưa có — luôn write vào boss DB
            if (!hasMembers) {
                const rawMembers = groupData.memVerList || groupData.memberList ||
                    groupData.members || groupData.currentMems || [];
                if (rawMembers.length > 0) {
                    // memVerList có thể là array of strings "uid_version" hoặc array of objects
                    const members = rawMembers.map((m) => {
                        let memberId;
                        if (typeof m === 'string') {
                            memberId = m.replace(/_\d+$/, ''); // "uid_0" → "uid"
                        }
                        else {
                            memberId = String(m.id || m.userId || m.uid || m.memberId || '');
                        }
                        return {
                            memberId,
                            displayName: (typeof m === 'object' ? (m.dName || m.displayName || m.name || '') : ''),
                            avatar: (typeof m === 'object' ? (m.avt || m.avatar || '') : ''),
                            role: memberId === creatorId ? 1 :
                                adminIds.includes(memberId) ? 2 : 0,
                        };
                    }).filter((m) => m.memberId);
                    if (members.length > 0) {
                        EventBroadcaster_1.default.runOnBossDb((bossDb) => bossDb.saveGroupMembers(zaloId, groupId, members));
                        Logger_1.default.log(`[ZaloLoginHelper] ✅ Saved ${members.length} members for group ${groupId}`);
                    }
                }
            }
        }
        catch (err) {
            Logger_1.default.warn(`[ZaloLoginHelper] fetchGroupInfoIfMissing failed for ${groupId}: ${err.message}`);
            ZaloLoginHelper.fetchedGroupIds.delete(cacheKey); // allow retry
        }
    }
    /**
     * Fetch tất cả nhóm trong nền khi tài khoản đăng nhập lần đầu.
     * Gọi getAllGroups → lấy danh sách groupId → fetch info + members từng nhóm.
     * Xử lý song song theo batch (concurrency=5) để giảm thời gian chờ.
     */
    static async fetchAllGroupsInBackground(zaloId, api) {
        try {
            Logger_1.default.log(`[ZaloLoginHelper] 🔍 [FirstLogin] Fetching all groups for new account ${zaloId}...`);
            const res = await api.getAllGroups();
            const groupIds = Object.keys(res?.gridVerMap || {});
            Logger_1.default.log(`[ZaloLoginHelper] [FirstLogin] Found ${groupIds.length} groups for ${zaloId}`);
            const CONCURRENCY = 5;
            for (let i = 0; i < groupIds.length; i += CONCURRENCY) {
                const batch = groupIds.slice(i, i + CONCURRENCY);
                await Promise.allSettled(batch.map(groupId => ZaloLoginHelper.fetchGroupInfoIfMissing(zaloId, groupId, api)));
                // Delay nhỏ giữa các batch để không spam API
                if (i + CONCURRENCY < groupIds.length) {
                    await new Promise((r) => setTimeout(r, 300));
                }
            }
            Logger_1.default.log(`[ZaloLoginHelper] ✅ [FirstLogin] Done fetching all groups for ${zaloId}`);
        }
        catch (err) {
            Logger_1.default.warn(`[ZaloLoginHelper] fetchAllGroupsInBackground failed: ${err.message}`);
        }
    }
    /**
     * Fetch toàn bộ bạn bè trong nền khi tài khoản đăng nhập lần đầu.
     * Gọi getAllFriends → normalize → lưu vào bảng friends + cập nhật contacts.
     * Dùng batch insert để tránh N lần disk write (10k bạn = 1 disk write thay vì 10k).
     */
    static async fetchAllFriendsInBackground(zaloId, api) {
        try {
            Logger_1.default.log(`[ZaloLoginHelper] 👥 [FirstLogin] Fetching all friends for new account ${zaloId}...`);
            const db = DatabaseService_1.default.getInstance();
            const res = await api.getAllFriends();
            // API trả về User[] hoặc object map
            let list = [];
            if (Array.isArray(res))
                list = res;
            else if (res && typeof res === 'object')
                list = Object.values(res);
            if (list.length === 0) {
                Logger_1.default.log(`[ZaloLoginHelper] [FirstLogin] No friends found for ${zaloId}`);
                return;
            }
            // Normalize và lưu vào bảng friends (batch — single disk write)
            const normalized = list.map((f) => ({
                userId: f.userId || f.uid || '',
                displayName: f.displayName || f.zaloName || f.display_name || '',
                avatar: f.avatar || '',
                phoneNumber: f.phoneNumber || f.phone || '',
            })).filter((f) => f.userId);
            if (normalized.length > 0) {
                db.saveFriends(zaloId, normalized);
                Logger_1.default.log(`[ZaloLoginHelper] [FirstLogin] Saved ${normalized.length} friends to friends table`);
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
                Logger_1.default.log(`[ZaloLoginHelper] ✅ [FirstLogin] Batch saved ${contactBatch.length} friends to contacts table for ${zaloId}`);
            }
        }
        catch (err) {
            Logger_1.default.warn(`[ZaloLoginHelper] fetchAllFriendsInBackground failed: ${err.message}`);
        }
    }
    /**
     * Đăng nhập bằng Cookies/IMEI
     */
    async loginCookies(imei, cookies, userAgent) {
        const zalo = new zca_js_1.Zalo(this.createZaloConfig({ selfListen: true }));
        const credentials = {
            cookie: JSON.parse(cookies),
            imei,
            userAgent,
        };
        try {
            const api = await zalo.login(credentials);
            const zaloId = api.getOwnId();
            if (!zaloId)
                throw new Error("Login thất bại: không lấy được zaloId");
            const isNewAccount = !DatabaseService_1.default.getInstance().hasAccount(zaloId);
            const accountInfo = await api.fetchAccountInfo();
            await this.connectZaloUser({ imei, cookies, userAgent }, api);
            // Nếu là tài khoản mới → fetch toàn bộ bạn bè + nhóm + thành viên ngầm
            if (isNewAccount) {
                ZaloLoginHelper.fetchAllFriendsInBackground(zaloId, api);
                ZaloLoginHelper.fetchAllGroupsInBackground(zaloId, api);
            }
            Logger_1.default.log(`[ZaloLoginHelper] Cookies login success: ${zaloId}`);
            return accountInfo;
        }
        catch (error) {
            Logger_1.default.error(`[ZaloLoginHelper] loginCookies failed: ${error.message}`);
            throw new Error(`Đăng nhập thất bại: ${error.message}`);
        }
    }
    /**
     * Kết nối user, thiết lập listeners
     */
    async connectZaloUser(auth, api) {
        try {
            Logger_1.default.log(`[ZaloLoginHelper] connectZaloUser starting...`);
            // Nếu đây là fresh login (api được cung cấp từ QR/cookies),
            // huỷ ngay reconnect timer đang chờ để tránh race condition
            if (api) {
                const freshZaloId = api.getOwnId();
                if (freshZaloId)
                    ZaloLoginHelper.cancelReconnect(freshZaloId);
            }
            const connection = await ConnectionManager_1.default.getOrCreateConnection(auth, true, api);
            const zaloId = connection.api.getOwnId();
            // Bỏ đánh dấu "removed" nếu account được kết nối lại
            ZaloLoginHelper.removedAccounts.delete(zaloId);
            if (ConnectionManager_1.default.isListenerStarted(zaloId)) {
                Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} already has active listener`);
                return true;
            }
            this.setupEventListeners(zaloId, connection);
            return true;
        }
        catch (error) {
            Logger_1.default.error(`[ZaloLoginHelper] connectZaloUser failed: ${error.message}`);
            return false;
        }
    }
    /**
     * Ngắt kết nối user
     */
    async disconnectUser(zaloId) {
        // Cancel any pending reconnect so we don't re-connect after manual disconnect
        ZaloLoginHelper.cancelReconnect(zaloId);
        const connection = ConnectionManager_1.default.getConnection(zaloId);
        if (!connection) {
            Logger_1.default.warn(`[ZaloLoginHelper] ${zaloId} not found`);
            return;
        }
        const authKey = connection.authKey;
        if (connection.listener) {
            try {
                if (ConnectionManager_1.default.isConnected(zaloId)) {
                    connection.listener.stop();
                    Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} listener stopped`);
                }
            }
            catch (error) {
                Logger_1.default.warn(`[ZaloLoginHelper] Stop listener warning: ${error.message}`);
            }
            ConnectionManager_1.default.setListenerStarted(zaloId, false);
        }
        ConnectionManager_1.default.removeConnection(zaloId);
        ConnectionManager_1.default.clearConnectionLock(zaloId);
        if (authKey)
            ConnectionManager_1.default.removePendingConnection(authKey);
        Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} disconnected`);
    }
    /**
     * Ngắt kết nối tất cả
     */
    async disconnectAllUsers() {
        const connections = ConnectionManager_1.default.getAllConnections();
        for (const zaloId of connections.keys()) {
            await this.disconnectUser(zaloId);
        }
        return true;
    }
    /**
     * Đăng nhập Zalo (internal)
     */
    async loginZalo(auth) {
        const zalo = new zca_js_1.Zalo(this.createZaloConfig({ selfListen: true }));
        let cookieParsed;
        try {
            cookieParsed = JSON.parse(auth.cookies);
        }
        catch {
            throw new Error('Cookies tài khoản không hợp lệ (có thể bị mã hóa sai hoặc dữ liệu cũ). ' +
                'Vui lòng đăng xuất và đăng nhập lại tài khoản này.');
        }
        const credentials = {
            cookie: cookieParsed,
            imei: auth.imei,
            userAgent: auth.userAgent,
        };
        return await zalo.login(credentials);
    }
    async requestOldMessages(auth) {
        try {
            const connection = await ConnectionManager_1.default.getOrCreateConnection(auth, true);
            const zaloId = connection.api.getOwnId();
            if (ConnectionManager_1.default.isConnected(zaloId)) {
                connection.api.listener.requestOldMessages(zca_js_1.ThreadType.User, null);
                connection.api.listener.requestOldMessages(zca_js_1.ThreadType.Group, null);
                return true;
            }
            return false;
        }
        catch (error) {
            Logger_1.default.error(`[ZaloLoginHelper] requestOldMessages failed: ${error.message}`);
            return false;
        }
    }
    /**
     * Thiết lập event listeners và broadcast qua EventBroadcaster
     */
    setupEventListeners(zaloId, connection) {
        const { listener } = connection;
        listener.on("message", async (message) => {
            try {
                // DEBUG LOG: xem cấu trúc message thực tế từ zca-js (main process)
                Logger_1.default.log(`[ZaloLoginHelper] 📩 RAW message event: ${JSON.stringify({
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
                    'data.message': message.data?.message,
                    'top_level_keys': Object.keys(message),
                    'full_message': message,
                })}`);
                // ─── Xử lý chat.delete (xoá tin nhắn phía tôi) ─────────────────
                const msgType = message.data?.msgType;
                if (msgType === 'chat.delete') {
                    const threadId = message.threadId || '';
                    const contentArr = Array.isArray(message.data?.content) ? message.data.content : [];
                    // Lấy globalDelMsgId từ mảng delete items
                    const msgIds = contentArr
                        .map((item) => String(item.globalDelMsgId || item.clientDelMsgId || ''))
                        .filter(Boolean);
                    Logger_1.default.log(`[ZaloLoginHelper] 🗑️ chat.delete: thread=${threadId} msgIds=${JSON.stringify(msgIds)}`);
                    EventBroadcaster_1.default.broadcastDeleteMessages(zaloId, msgIds, threadId);
                    return;
                }
                // ─── Xử lý chat.ecard (reminder notification) ─────────────────
                if (msgType === 'chat.ecard') {
                    const content = message.data?.content;
                    if (content && typeof content === 'object') {
                        const params = typeof content.params === 'string' ? (() => {
                            try {
                                return JSON.parse(content.params);
                            }
                            catch {
                                return null;
                            }
                        })() : content.params;
                        // Kiểm tra xem có phải reminder không
                        if (params?.actions?.[0]?.actionId === 'action.open.reminder') {
                            Logger_1.default.log(`[ZaloLoginHelper] ⏰ Reminder notification: thread=${message.threadId} title="${content.title}"`);
                            EventBroadcaster_1.default.broadcastReminderNotification(zaloId, message.threadId || '', msgType, content);
                        }
                    }
                }
                message.zaloId = zaloId;
                await EventBroadcaster_1.default.broadcastMessage(zaloId, message);
                // ─── For group messages: fetch group info in background if not cached ─
                if (message.type === 1) {
                    const groupId = message.threadId || '';
                    if (groupId) {
                        ZaloLoginHelper.fetchGroupInfoIfMissing(zaloId, groupId, connection.api);
                    }
                }
            }
            catch (error) {
                Logger_1.default.error(`[ZaloLoginHelper] message event error: ${error.message}`);
            }
        });
        listener.on("group_event", (event) => {
            Logger_1.default.log(`[ZaloLoginHelper] 📩 RAW group_event event: ${JSON.stringify({
                event: event,
            })}`);
            try {
                const groupId = event.threadId || event.data?.groupId || event.groupId || '';
                EventBroadcaster_1.default.broadcastGroupEvent(zaloId, groupId, event.type, event);
                // For member-change events EventBroadcaster already updates DB surgically,
                // so no need to fetch full group info. Only fetch for structural events
                // where group name/avatar may be missing (new group, update, etc.)
                const MEMBER_EVENTS = new Set(['join', 'leave', 'remove_member', 'block_member', 'add_admin', 'remove_admin']);
                if (groupId && !MEMBER_EVENTS.has(event.type)) {
                    ZaloLoginHelper.fetchGroupInfoIfMissing(zaloId, groupId, connection.api);
                }
            }
            catch (error) {
                Logger_1.default.error(`[ZaloLoginHelper] group_event error: ${error.message}`);
            }
        });
        listener.on("reaction", async (reaction) => {
            try {
                // DEBUG: log toàn bộ reaction object
                Logger_1.default.log(`[ZaloLoginHelper] 🎭 RAW reaction: ${JSON.stringify({
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
                const threadId = reaction.threadId || rData.idTo || rData.threadId || '';
                const isGroup = !!reaction.isGroup;
                if (uidFrom && uidFrom !== zaloId) {
                    const db = DatabaseService_1.default.getInstance();
                    let isKnown = false;
                    // Kiểm tra bảng thành viên nhóm trước
                    if (isGroup && threadId) {
                        const members = db.getGroupMembers(zaloId, threadId);
                        isKnown = members.some((m) => m.member_id === uidFrom);
                    }
                    // Kiểm tra bảng contacts nếu chưa tìm thấy
                    if (!isKnown) {
                        const contacts = db.getContacts(zaloId);
                        isKnown = contacts.some((c) => c.contact_id === uidFrom);
                    }
                    if (!isKnown) {
                        // Người dùng chưa có trong hệ thống → fetch thông tin và lưu vào DB
                        try {
                            const userInfoRes = await connection.api.getUserInfo(uidFrom);
                            const profile = userInfoRes?.changed_profiles?.[uidFrom]
                                || userInfoRes?.data?.[uidFrom];
                            if (profile) {
                                const { displayName, avatar, phone, gender, birthday } = (0, profileUtils_1.extractUserProfile)(profile);
                                if (isGroup && threadId) {
                                    db.upsertGroupMember(zaloId, threadId, {
                                        memberId: uidFrom,
                                        displayName,
                                        avatar,
                                        role: 0,
                                    });
                                    Logger_1.default.log(`[ZaloLoginHelper] ✅ Added reaction sender ${uidFrom} (${displayName}) to group members of ${threadId}`);
                                }
                                else {
                                    db.updateContactProfile(zaloId, uidFrom, displayName, avatar, phone, '', gender, birthday);
                                    Logger_1.default.log(`[ZaloLoginHelper] ✅ Added reaction sender ${uidFrom} (${displayName}) to contacts`);
                                }
                            }
                        }
                        catch (fetchErr) {
                            Logger_1.default.warn(`[ZaloLoginHelper] Failed to fetch reaction sender ${uidFrom}: ${fetchErr.message}`);
                        }
                    }
                }
                // ────────────────────────────────────────────────────────────────
                reaction.zaloId = zaloId;
                EventBroadcaster_1.default.broadcastReaction(zaloId, reaction);
            }
            catch (error) {
                Logger_1.default.error(`[ZaloLoginHelper] reaction event error: ${error.message}`);
            }
        });
        listener.on("undo", (undo) => {
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
                const d = undo.data || undo;
                const content = d.content || {};
                // globalMsgId là ID số lớn → chuyển sang string
                const recalledMsgId = String(content.globalMsgId ||
                    content.cliMsgId ||
                    d.realMsgId ||
                    d.msgId ||
                    undo.msgId || '');
                const threadId = undo.threadId || d.idTo || d.srcId || '';
                Logger_1.default.log(`[ZaloLoginHelper] ↩️ undo: recalledMsgId=${recalledMsgId} threadId=${threadId} isSelf=${undo.isSelf} isGroup=${undo.isGroup} raw=${JSON.stringify({
                    msgId: d.msgId, realMsgId: d.realMsgId,
                    'content.globalMsgId': content.globalMsgId,
                    'content.cliMsgId': content.cliMsgId,
                    threadId: undo.threadId,
                })}`);
                if (recalledMsgId) {
                    EventBroadcaster_1.default.broadcastUndo(zaloId, recalledMsgId, threadId);
                }
            }
            catch (error) {
                Logger_1.default.error(`[ZaloLoginHelper] undo event error: ${error.message}`);
            }
        });
        listener.on("typing", (data) => {
            Logger_1.default.log(`[ZaloLoginHelper] 📩 RAW typing event: ${JSON.stringify(data)}`);
            try {
                EventBroadcaster_1.default.broadcastTyping(zaloId, data);
            }
            catch { }
        });
        listener.on("seen", (data) => {
            Logger_1.default.log(`[ZaloLoginHelper] 📩 RAW seen event: ${JSON.stringify(data)}`);
            try {
                EventBroadcaster_1.default.broadcastSeen(zaloId, data);
            }
            catch { }
        });
        listener.on("old_messages", async (messages) => {
            Logger_1.default.log(`[ZaloLoginHelper] 📩 RAW old_messages event: ${messages.length} messages`);
            try {
                for (const message of messages) {
                    message.zaloId = zaloId;
                    await EventBroadcaster_1.default.broadcastMessage(zaloId, message, { silent: true });
                }
            }
            catch (error) {
                Logger_1.default.error(`[ZaloLoginHelper] old_messages error: ${error.message}`);
            }
        });
        listener.on("friend_event", async (event) => {
            Logger_1.default.log(`[ZaloLoginHelper] 📩 RAW friend_event event: ${JSON.stringify(event)}`);
            try {
                const eventType = event?.type ?? -1;
                const isSelf = event?.isSelf === true;
                const d = event?.data;
                const resolveFriendUserId = (raw, prefer = 'auto') => {
                    if (typeof raw === 'string')
                        return raw;
                    if (prefer === 'from') {
                        return String(raw?.fromUid || raw?.uid || raw?.userId || raw?.actorId || raw?.toUid || '');
                    }
                    if (prefer === 'to') {
                        return String(raw?.toUid || raw?.uid || raw?.userId || raw?.fromUid || raw?.actorId || '');
                    }
                    return String(raw?.fromUid || raw?.uid || raw?.userId || raw?.toUid || raw?.actorId || '');
                };
                const resolveFriendMessage = (raw) => {
                    if (!raw || typeof raw !== 'object')
                        return '';
                    return String(raw.message || raw.msg || raw?.recommInfo?.message || raw?.recommInfo?.customText || '');
                };
                const fetchFriendProfile = async (userId) => {
                    let displayName = '';
                    let avatar = '';
                    let phone = '';
                    try {
                        const userInfoRes = await connection.api.getUserInfo(userId);
                        const rawProfile = userInfoRes?.changed_profiles?.[userId]
                            || userInfoRes?.data?.[userId];
                        if (rawProfile) {
                            const extracted = (0, profileUtils_1.extractUserProfile)(rawProfile);
                            displayName = extracted.displayName;
                            avatar = extracted.avatar;
                            phone = extracted.phone;
                            const db = DatabaseService_1.default.getInstance();
                            db.updateContactProfile(zaloId, userId, displayName, avatar, phone, '', extracted.gender, extracted.birthday);
                        }
                    }
                    catch (err) {
                        Logger_1.default.warn(`[ZaloLoginHelper] friend_event getUserInfo(${userId}) failed: ${err.message}`);
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
                        Logger_1.default.warn(`[ZaloLoginHelper] friend_event REQUEST missing peer userId (isSelf=${isSelf})`);
                        return;
                    }
                    const { displayName, avatar, phone } = await fetchFriendProfile(friendId);
                    if (isSelf) {
                        EventBroadcaster_1.default.broadcastFriendRequestSent(zaloId, {
                            userId: friendId,
                            displayName,
                            avatar,
                            phoneNumber: phone,
                            msg,
                        });
                    }
                    else {
                        EventBroadcaster_1.default.broadcastFriendRequest(zaloId, {
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
                        EventBroadcaster_1.default.broadcastFriendAccepted(zaloId, {
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
                    const friendId = typeof d === 'string' ? d : (d.fromUid || d.uid || '');
                    if (friendId) {
                        EventBroadcaster_1.default.broadcastFriendRemoved(zaloId, friendId);
                    }
                    return;
                }
                // ── FriendEventType.REJECT_REQUEST (4) / UNDO_REQUEST (3) ──────
                if ((eventType === 4 || eventType === 3) && d && typeof d === 'object') {
                    const friendId = isSelf
                        ? resolveFriendUserId(d, 'to')
                        : resolveFriendUserId(d, 'from');
                    if (friendId) {
                        const direction = eventType === 4
                            ? (isSelf ? 'received' : 'sent')
                            : (isSelf ? 'sent' : 'received');
                        const reason = eventType === 4
                            ? (isSelf ? 'rejected_by_me' : 'rejected_by_them')
                            : (isSelf ? 'cancelled_by_me' : 'cancelled_by_them');
                        EventBroadcaster_1.default.broadcastFriendRequestRemoved(zaloId, {
                            userId: friendId,
                            direction,
                            reason,
                        });
                    }
                    return;
                }
                // ── Other types: SEEN(5), BLOCK(6), UNBLOCK(7), etc. ────────────
                // Just log — no user-facing notification needed
                Logger_1.default.log(`[ZaloLoginHelper] friend_event type=${eventType} (no action needed)`);
            }
            catch (error) {
                Logger_1.default.error(`[ZaloLoginHelper] friend_event error: ${error.message}`);
            }
        });
        listener.on("connected", () => {
            Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} ✅ Connected`);
            ConnectionManager_1.default.setConnected(zaloId, true);
            DatabaseService_1.default.getInstance().setListenerActive(zaloId, true);
            EventBroadcaster_1.default.broadcastConnected(zaloId, { zaloId });
        });
        const handleDisconnection = (eventType, code, reason) => {
            Logger_1.default.warn(`[ZaloLoginHelper] ${zaloId} ${eventType} - Code: ${code}, Reason: ${reason}`);
            ConnectionManager_1.default.setConnected(zaloId, false);
            ConnectionManager_1.default.setListenerStarted(zaloId, false);
            EventBroadcaster_1.default.broadcastDisconnected(zaloId, `${eventType} - ${zca_js_1.CloseReason[code] || code}`);
            const currentConnection = ConnectionManager_1.default.getConnection(zaloId);
            if (currentConnection && currentConnection === connection) {
                ConnectionManager_1.default.removeConnection(zaloId);
            }
            else if (currentConnection && currentConnection !== connection) {
                // Connection bị thay thế bởi fresh login (QR/cookies) trong khi listener cũ vẫn chạy
                // → listener cũ đang đóng, không reconnect — connection mới đang hoạt động
                Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} stale connection closed (replaced by newer) — skipping reconnect`);
                return;
            }
            // ── Auto-reconnect ────────────────────────────────────────────────
            // Một số CloseReason cho biết token không còn hiệu lực → không retry
            // Hiện tại thì retry tất cả cho chắc
            const fatalCodes = new Set([]);
            if (fatalCodes.has(code)) {
                Logger_1.default.warn(`[ZaloLoginHelper] ${zaloId} fatal disconnect (${zca_js_1.CloseReason[code]}) — marking listener_active=0`);
                DatabaseService_1.default.getInstance().setListenerActive(zaloId, false);
                EventBroadcaster_1.default.broadcastListenerDead(zaloId, `fatal_${zca_js_1.CloseReason[code] || code}`);
                return;
            }
            // Nếu account đã bị xóa chủ động → không reconnect
            if (ZaloLoginHelper.removedAccounts.has(zaloId)) {
                Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} was removed — skipping reconnect`);
                ZaloLoginHelper.removedAccounts.delete(zaloId);
                return;
            }
            ZaloLoginHelper.scheduleReconnect(zaloId, connection.auth, 0);
        };
        listener.on("disconnected", (code, reason) => {
            handleDisconnection('disconnected', code, reason);
        });
        listener.on("closed", (code, reason) => {
            handleDisconnection('closed', code, reason);
        });
        listener.on("error", (error) => {
            Logger_1.default.error(`[ZaloLoginHelper] ${zaloId} error: ${error?.message || error}`);
        });
        listener.start();
        ConnectionManager_1.default.setListenerStarted(zaloId, true);
        Logger_1.default.log(`[ZaloLoginHelper] ${zaloId} 🎧 Listener started`);
    }
}
// Map lưu các abort functions cho QR đang chờ
ZaloLoginHelper.activeQRAbortFns = new Map();
// Set lưu các group IDs đã fetch info để tránh gọi lại
ZaloLoginHelper.fetchedGroupIds = new Set();
// Đếm số lần reconnect đang thử cho mỗi account
ZaloLoginHelper.reconnectAttempts = new Map();
// Timer handles để có thể cancel
ZaloLoginHelper.reconnectTimers = new Map();
// Set lưu các account đã bị xóa chủ động — KHÔNG reconnect
ZaloLoginHelper.removedAccounts = new Set();
/** Callback được gọi khi QR login thành công */
ZaloLoginHelper.onQRSuccessCallback = null;
/** Callback được gọi sau khi fetch phone/bizPkg hoàn tất — dùng để sync phone lên Sheets */
ZaloLoginHelper.onProfileReadyCallback = null;
// Đăng ký callback invalidate group cache vào EventBroadcaster
// (tránh circular import: EventBroadcaster không import ZaloLoginHelper)
(0, EventBroadcaster_1.registerGroupCacheInvalidator)((zaloId, groupId) => {
    ZaloLoginHelper.invalidateGroupCache(zaloId, groupId);
});
exports.default = ZaloLoginHelper;
//# sourceMappingURL=ZaloLoginHelper.js.map