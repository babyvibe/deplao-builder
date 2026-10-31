/**
 * MobileSyncService — "Đồng bộ tin nhắn từ điện thoại" cho tài khoản Zalo.
 *
 * Luồng (giống Zalo PC/Web):
 *   pullMobile(public_key) → điện thoại hỏi người dùng → control event syncmsgmb:
 *     user_confirm → (transfer_error status 1/2: đang chuẩn bị / máy đang ngủ) → syncmsg_info {url, encrypted_key}
 *   → tải `.db.crypt` → giải RSA lấy khoá → giải mã + giải nén ZDB4.0 → các SQLite `<uid>.db` / `group_<gid>.db`
 *   → đổi ID mobile (plain) sang ID web (noise) bằng API znoise → lưu hàng loạt vào bảng messages.
 *
 * Nhờ znoise, tin nhắn lịch sử nằm ĐÚNG hội thoại hiện có (cùng thread_id với tin realtime), không cần
 * dò tương quan msgId như cách tạm trước đây.
 *
 * Khoảng thời gian: người dùng chọn trên modal (mặc định 1 tuần gần nhất). `fromTs` được gửi cho điện thoại
 * làm `from_seq_id` (cách Zalo PC xin "chỉ tin mới") và cả 2 đầu được lọc ngay trong câu SQL khi đọc bản sao lưu,
 * nên điện thoại có gửi dư thì tin ngoài khoảng cũng không bị đọc / nhập.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import BetterSqlite3 from 'better-sqlite3';
import Logger from '../../../utils/Logger';
import ConnectionManager from '../../../utils/connection/ConnectionManager';
import EventBroadcaster from '../../event/EventBroadcaster';
import {
    MobileSyncRange,
    MobileSyncStage,
    MobileSyncStats,
    MobileSyncStatus,
    SyncDbInfo,
    SyncEvent,
    SyncEventType,
    TSyncEventSyncMsgInfo,
} from './types';
import { attachSyncEventListener, DEFAULT_SYNC_PC_NAME, installMobileSyncApis, MobileSyncApi } from './zcaMobileSync';
import { decryptBackupKey, ExtractedFile, extractZdbBackup, generateSyncKeyPair, verifyChecksum } from './zdbBackup';
import { downloadBackupFile } from './backupDownload';
import {
    chatContentOutOfRangeCount,
    chatContentQueryRange,
    collectPlainUserIds,
    ImportedZaloMessage,
    parseThreadFileName,
    PlainMessage,
    rowToPlainMessage,
    toZaloMessage,
} from './mobileMessageConverter';

export const MOBILE_SYNC_EVENT = 'event:mobileSync';

const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;
const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;
/** ~1000 dòng/transaction ≈ 50ms chặn main process (đã đo cả trigger FTS). */
const IMPORT_BATCH_SIZE = 1000;
const NOISE_BATCH_SIZE = 500;
const PROFILE_BATCH_SIZE = 50;
const MAX_PROFILE_LOOKUPS = 1000;
const PROGRESS_THROTTLE_MS = 300;

const TERMINAL_STAGES: MobileSyncStage[] = ['completed', 'failed', 'cancelled'];
const WAITING_STAGES: MobileSyncStage[] = ['requesting', 'waiting_confirm', 'waiting_backup', 'mobile_idle'];

interface SyncSession {
    zaloId: string;
    publicKey: string;
    privateKey: string;
    pcName: string;
    status: MobileSyncStatus;
    timer: NodeJS.Timeout | null;
    cancelled: boolean;
    importing: boolean;
    lastEmitAt: number;
}

class MobileSyncCancelled extends Error {
    constructor() {
        super('cancelled');
    }
}

function emptyStats(): MobileSyncStats {
    return {
        conversations: 0,
        conversationsResolved: 0,
        conversationsUnresolved: 0,
        messagesRead: 0,
        messagesImported: 0,
        messagesSkipped: 0,
        messagesOutOfRange: 0,
        durationMs: 0,
    };
}

function positiveTs(value: unknown): number | null {
    const n = Math.floor(Number(value) || 0);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function fmtTs(ts: number | null | undefined): string {
    return ts ? new Date(ts).toISOString() : '—';
}

class MobileSyncService {
    private static instance: MobileSyncService;
    private sessions = new Map<string, SyncSession>();
    private detachers = new Map<string, () => void>();
    /** Instance zca-js đang được gắn listener cho từng tài khoản (mỗi lần reconnect là 1 api mới). */
    private attachedApis = new Map<string, any>();

    public static getInstance(): MobileSyncService {
        if (!MobileSyncService.instance) MobileSyncService.instance = new MobileSyncService();
        return MobileSyncService.instance;
    }

    /** Gắn API + listener sự kiện đồng bộ cho mỗi instance zca-js mới (gọi khi listener được dựng). */
    public attachToApi(zaloId: string, api: any): void {
        this.detachers.get(zaloId)?.();
        this.detachers.delete(zaloId);
        this.attachedApis.delete(zaloId);
        try {
            installMobileSyncApis(api);
            this.detachers.set(zaloId, attachSyncEventListener(api, event => this.onSyncEvent(zaloId, event)));
            this.attachedApis.set(zaloId, api);
        } catch (err: any) {
            Logger.warn(`[MobileSync] ${zaloId}: không gắn được listener đồng bộ: ${err?.message}`);
        }
    }

    public getStatus(zaloId: string): MobileSyncStatus | null {
        return this.sessions.get(zaloId)?.status ?? null;
    }

    /**
     * Bắt đầu đồng bộ khoảng thời gian [fromTs, toTs] (ms). Không truyền = toàn bộ lịch sử trên điện thoại.
     * Tin đã có trong DB được bỏ qua (INSERT OR IGNORE) nên chọn khoảng chồng lên lần trước cũng không sao.
     */
    public async start(zaloId: string, request: Partial<MobileSyncRange> = {}): Promise<{ success: boolean; status?: MobileSyncStatus; error?: string }> {
        const fromTs = positiveTs(request.fromTs);
        const toTs = positiveTs(request.toTs);
        if (fromTs && toTs && fromTs > toTs) return { success: false, error: 'Ngày bắt đầu phải trước ngày kết thúc' };
        const existing = this.sessions.get(zaloId);
        if (existing && !TERMINAL_STAGES.includes(existing.status.stage)) {
            return { success: false, status: existing.status, error: 'Đang có một phiên đồng bộ chạy cho tài khoản này' };
        }
        const conn = ConnectionManager.getConnection(zaloId);
        if (!conn?.api || !conn.connected) return { success: false, error: 'Tài khoản không online' };
        if (this.attachedApis.get(zaloId) !== conn.api) this.attachToApi(zaloId, conn.api);
        const api = installMobileSyncApis(conn.api);

        const { publicKey, privateKey } = generateSyncKeyPair();
        const now = Date.now();
        const session: SyncSession = {
            zaloId,
            publicKey,
            privateKey,
            pcName: DEFAULT_SYNC_PC_NAME,
            cancelled: false,
            importing: false,
            timer: null,
            lastEmitAt: 0,
            status: {
                zaloId,
                stage: 'requesting',
                progress: 0,
                message: 'Đang gửi yêu cầu tới điện thoại...',
                pcName: DEFAULT_SYNC_PC_NAME,
                range: { fromTs, toTs },
                startedAt: now,
                updatedAt: now,
            },
        };
        this.sessions.set(zaloId, session);
        this.emit(session, true);

        try {
            // Gợi ý điện thoại chỉ gửi tin từ fromTs (Zalo PC: from_seq_id = maxSeq + 1, "seq" = TimeStamp ms).
            // Điện thoại có bỏ qua gợi ý thì vẫn lọc đúng [fromTs, toTs] khi đọc bản sao lưu.
            await api.pullMobile({ public_key: publicKey, pc_name: session.pcName, from_seq_id: fromTs ?? 0, min_seq_id: 0 });
        } catch (err: any) {
            if (!session.cancelled) this.fail(session, `Không gửi được yêu cầu đồng bộ: ${err?.message || err}`);
            return { success: false, status: session.status, error: session.status.error };
        }
        if (session.cancelled) return { success: false, status: session.status, error: 'Đã huỷ' };

        Logger.log(`[MobileSync] ${zaloId}: đã gửi pull_mobile_msg (from_seq_id=${fromTs ?? 0}, khoảng ${fmtTs(fromTs)} → ${fmtTs(toTs)}), chờ xác nhận trên điện thoại`);
        this.setStage(session, 'waiting_confirm', 'Mở Zalo trên điện thoại và bấm "Đồng ý" để đồng bộ tin nhắn sang máy tính');
        this.armTimeout(session, CONFIRM_TIMEOUT_MS, 'Hết thời gian chờ xác nhận trên điện thoại');
        return { success: true, status: session.status };
    }

    public async cancel(zaloId: string): Promise<{ success: boolean; status?: MobileSyncStatus }> {
        const session = this.sessions.get(zaloId);
        if (!session || TERMINAL_STAGES.includes(session.status.stage)) return { success: true, status: session?.status };
        session.cancelled = true;
        this.clearTimer(session);
        if (!session.importing) {
            await this.cancelOnServer(session);
            this.finish(session, 'cancelled', 'Đã huỷ đồng bộ');
        }
        // Đang tải/giải mã/nhập → vòng xử lý tự dừng ở bước kế tiếp rồi chuyển sang 'cancelled'.
        return { success: true, status: session.status };
    }

    // ─── Sự kiện từ điện thoại ───────────────────────────────────────────────

    private onSyncEvent(zaloId: string, event: SyncEvent): void {
        const session = this.sessions.get(zaloId);
        if (!session || session.importing || TERMINAL_STAGES.includes(session.status.stage)) return;
        const data: any = event.data || {};
        if (data.public_key !== session.publicKey) return;
        if (event.type !== SyncEventType.SYNCMSG_INFO && data.pc_name !== undefined && data.pc_name !== session.pcName) return;

        Logger.log(`[MobileSync] ${zaloId}: sự kiện ${event.act} ${event.type === SyncEventType.SYNCMSG_INFO ? '' : JSON.stringify({ user_action: data.user_action, status: data.status, error_code: data.error_code })}`);
        switch (event.type) {
            case SyncEventType.USER_CONFIRM: {
                const action = Number(data.user_action);
                if (action === 1 || action === 3) {
                    this.setStage(session, 'waiting_backup', 'Điện thoại đang chuẩn bị dữ liệu tin nhắn, vui lòng giữ Zalo mở trên điện thoại...');
                    this.armTimeout(session, BACKUP_TIMEOUT_MS, 'Hết thời gian chờ điện thoại gửi dữ liệu');
                } else if (action === 0) {
                    this.finish(session, 'cancelled', 'Bạn đã từ chối đồng bộ trên điện thoại');
                } else if (action === 2) {
                    this.fail(session, 'Điện thoại đang khôi phục dữ liệu, vui lòng thử lại sau');
                }
                break;
            }
            case SyncEventType.TRANSFER_ERROR: {
                const status = Number(data.status);
                const errorCode = Number(data.error_code || 0);
                if (status === 1) {
                    this.setStage(session, 'waiting_backup', 'Điện thoại đang chuẩn bị dữ liệu tin nhắn, vui lòng giữ Zalo mở trên điện thoại...');
                    this.armTimeout(session, BACKUP_TIMEOUT_MS, 'Hết thời gian chờ điện thoại gửi dữ liệu');
                } else if (status === 2) {
                    this.setStage(session, 'mobile_idle', 'Điện thoại đang tạm dừng — mở Zalo trên điện thoại để tiếp tục đồng bộ');
                    this.armTimeout(session, BACKUP_TIMEOUT_MS, 'Hết thời gian chờ điện thoại gửi dữ liệu');
                } else if (errorCode !== 0) {
                    this.fail(session, `Điện thoại không tạo được bản sao lưu (mã ${data.error_code}${data.error_msg ? `: ${data.error_msg}` : ''})`);
                }
                break;
            }
            case SyncEventType.SYNCMSG_INFO:
                this.clearTimer(session);
                session.importing = true;
                void this.runImport(session, data as TSyncEventSyncMsgInfo);
                break;
            default:
                break;
        }
    }

    // ─── Tải + giải mã + nhập ────────────────────────────────────────────────

    private async runImport(session: SyncSession, info: TSyncEventSyncMsgInfo): Promise<void> {
        const startedAt = Date.now();
        const workDir = path.join(app.getPath('userData'), 'mobile-sync', session.zaloId, String(startedAt));
        const stats = emptyStats();
        // Trạng thái kết thúc chỉ phát SAU khi dọn file tạm (tránh "Đồng bộ lại" chồng lên bước dọn dẹp).
        let settle: () => void;
        try {
            const api = this.currentApi(session.zaloId);
            const dbInfo = this.parseDbInfo(info.db_info);
            // Số tin điện thoại gửi — so với khoảng đã chọn để biết điện thoại có chỉ gửi phần mới (from_seq_id) không.
            Logger.log(`[MobileSync] ${session.zaloId}: bản sao lưu db_info=${JSON.stringify(dbInfo)} file_size=${info.file_size ?? '?'}`);
            const format = dbInfo.db_format ?? 0;
            if (format !== 1) {
                throw new Error(`Định dạng sao lưu chưa được hỗ trợ (db_format=${format}). Hãy cập nhật Zalo trên điện thoại rồi thử lại.`);
            }
            // Giống Zalo PC: origin_db (nếu có) được ưu tiên hơn backup_db; msg_total = 0 → không có gì để nhập.
            const counts = dbInfo.origin_db || dbInfo.backup_db;
            if (counts && Number(counts.msg_total) === 0) {
                settle = () => this.finish(session, 'completed', session.status.range?.fromTs
                    ? 'Điện thoại không có tin nhắn nào trong khoảng thời gian đã chọn'
                    : 'Điện thoại không có tin nhắn nào để đồng bộ', stats);
                return;
            }

            await fs.promises.mkdir(workDir, { recursive: true });
            const cryptPath = path.join(workDir, 'backup.db.crypt');
            this.setStage(session, 'downloading', 'Đang tải dữ liệu từ máy chủ Zalo...');
            await this.downloadBackup(api, session, info, cryptPath);

            const checksumOk = await verifyChecksum(cryptPath, info.checksum_code || info.checksum);
            if (checksumOk === false) Logger.warn(`[MobileSync] ${session.zaloId}: checksum không khớp, vẫn thử giải mã`);
            this.throwIfCancelled(session);

            this.setStage(session, 'decrypting', 'Đang giải mã dữ liệu tin nhắn...');
            const { aesKey } = decryptBackupKey(session.privateKey, info.encrypted_key);
            const extracted = await extractZdbBackup({
                cryptPath,
                outDir: path.join(workDir, 'db'),
                aesKey,
                shouldAbort: () => session.cancelled,
                onProgress: p => this.setProgress(session, p.totalBytes ? (p.processedBytes / p.totalBytes) * 100 : 0),
            });
            await fs.promises.rm(cryptPath, { force: true });
            if (extracted.skippedEntries.length) {
                Logger.warn(`[MobileSync] ${session.zaloId}: bỏ qua ${extracted.skippedEntries.length} file có tên không hợp lệ`);
            }

            await this.importConversations(session, api, extracted.files, String(info.uid ?? ''), stats);
            stats.durationMs = Date.now() - startedAt;
            Logger.log(`[MobileSync] ${session.zaloId}: hoàn tất ${JSON.stringify(stats)}`);
            const rangeNote = session.status.range?.fromTs || session.status.range?.toTs ? ' trong khoảng thời gian đã chọn' : '';
            settle = () => this.finish(session, 'completed',
                `Đã đồng bộ ${stats.messagesImported.toLocaleString('vi-VN')} tin nhắn mới từ ${stats.conversationsResolved} hội thoại${rangeNote}`,
                stats);
        } catch (err: any) {
            stats.durationMs = Date.now() - startedAt;
            if (session.cancelled || err instanceof MobileSyncCancelled || err?.name === 'AbortError') {
                settle = () => this.finish(session, 'cancelled', 'Đã huỷ đồng bộ', stats);
            } else {
                Logger.error(`[MobileSync] ${session.zaloId}: lỗi ${err?.stack || err}`);
                settle = () => this.fail(session, err?.message || String(err), stats);
            }
        } finally {
            session.privateKey = '';
            if (process.env.DEPLAO_KEEP_MOBILE_SYNC_FILES !== '1') {
                await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
            }
            session.importing = false;
            settle?.();
        }
    }

    private parseDbInfo(raw: TSyncEventSyncMsgInfo['db_info']): SyncDbInfo {
        if (!raw) return {};
        if (typeof raw === 'object') return raw;
        try {
            return JSON.parse(raw) || {};
        } catch {
            throw new Error('Thông tin bản sao lưu từ điện thoại không hợp lệ');
        }
    }

    private async downloadBackup(api: any, session: SyncSession, info: TSyncEventSyncMsgInfo, destPath: string): Promise<void> {
        const ctx = api.getContext();
        // Zalo PC gửi toàn bộ cookie phiên của domain xác thực; với phiên web (zca-js) là cookie chat.zalo.me.
        let sessionCookie = '';
        try {
            sessionCookie = await ctx.cookie.getCookieString('https://chat.zalo.me/');
        } catch { /* tải không cookie */ }
        await downloadBackupFile({
            url: String(info.url || ''),
            userAgent: ctx.userAgent,
            sessionCookie,
            agent: ctx.options?.agent,
            destPath,
            expectedSize: Number(info.file_size) || 0,
            onProgress: percent => this.setProgress(session, percent),
            shouldAbort: () => session.cancelled,
            log: message => Logger.warn(`[MobileSync] ${session.zaloId}: ${message}`),
        });
    }

    private async importConversations(
        session: SyncSession, api: MobileSyncApi & any, files: ExtractedFile[], ownPlainId: string, stats: MobileSyncStats,
    ): Promise<void> {
        const zaloId = session.zaloId;
        const ownNoiseId = String(api.getOwnId?.() || zaloId);
        // `<uid của chính mình>.db` = hội thoại với chính mình (thread = ID tài khoản). "My Documents" của Zalo là hội
        // thoại riêng (ID send2me, ảnh thư mục) → ghép như mọi hội thoại 1-1 qua bảng ánh xạ ID, không đặt tên gì thêm.
        const threads = files
            .map(file => ({ file, ref: parseThreadFileName(file.name) }))
            .filter(t => t.ref !== null);
        stats.conversations = threads.length;

        this.setStage(session, 'resolving_ids', 'Đang ghép hội thoại với tài khoản trên máy tính...');
        const userMap = EventBroadcaster.withBossDb(db => db.getPlainIdMappings(zaloId, 'user'));
        const groupMap = EventBroadcaster.withBossDb(db => db.getPlainIdMappings(zaloId, 'group'));
        await this.resolveNoiseIds(api, session, 'user', threads.filter(t => !t.ref.isGroup).map(t => t.ref.plainId), userMap, ownPlainId);
        await this.resolveNoiseIds(api, session, 'group', threads.filter(t => t.ref.isGroup).map(t => t.ref.plainId), groupMap, ownPlainId);

        this.setStage(session, 'importing', 'Đang ghép tin nhắn vào các hội thoại...');
        const touched = new Map<string, boolean>(); // noise threadId → isGroup
        const fromTs = session.status.range?.fromTs ?? 0;
        const toTs = session.status.range?.toTs ?? 0;
        const query = chatContentQueryRange(fromTs, toTs);
        const outOfRangeQuery = chatContentOutOfRangeCount(fromTs, toTs);
        for (let i = 0; i < threads.length; i++) {
            this.throwIfCancelled(session);
            const { file, ref } = threads[i];
            const noiseId = ref.isGroup
                ? groupMap.get(ref.plainId)
                : (ref.plainId === ownPlainId ? ownNoiseId : userMap.get(ref.plainId));
            if (!noiseId) {
                stats.conversationsUnresolved++;
                continue;
            }
            stats.conversationsResolved++;
            const thread = { ...ref, noiseId };
            const db = new BetterSqlite3(file.path, { readonly: true, fileMustExist: true });
            try {
                const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ChatContent'`).get();
                if (!hasTable) continue;
                if (outOfRangeQuery) {
                    const row: any = db.prepare(outOfRangeQuery).get();
                    stats.messagesOutOfRange += Number(row?.outside) || 0;
                }
                const stmt = db.prepare(query).safeIntegers(true);
                let batch: PlainMessage[] = [];
                for (const row of stmt.iterate()) {
                    stats.messagesRead++;
                    const plain = rowToPlainMessage(row);
                    if (!plain) {
                        stats.messagesSkipped++;
                        continue;
                    }
                    batch.push(plain);
                    if (batch.length >= IMPORT_BATCH_SIZE) {
                        await this.flushBatch(api, session, batch, { ownNoiseId, ownPlainId, thread }, userMap, stats, touched);
                        batch = [];
                    }
                }
                if (batch.length) await this.flushBatch(api, session, batch, { ownNoiseId, ownPlainId, thread }, userMap, stats, touched);
            } catch (err: any) {
                if (err instanceof MobileSyncCancelled) throw err;
                Logger.warn(`[MobileSync] ${zaloId}: bỏ qua ${file.name}: ${err?.message}`);
            } finally {
                db.close();
            }
            this.setProgress(session, ((i + 1) / threads.length) * 100);
        }

        await this.refreshMissingProfiles(api, zaloId, touched);
    }

    private async flushBatch(
        api: any, session: SyncSession, batch: PlainMessage[],
        base: { ownNoiseId: string; ownPlainId: string; thread: { plainId: string; isGroup: boolean; noiseId: string } },
        userMap: Map<string, string>, stats: MobileSyncStats, touched: Map<string, boolean>,
    ): Promise<void> {
        const needed = new Set<string>();
        for (const m of batch) collectPlainUserIds(m, needed);
        await this.resolveNoiseIds(api, session, 'user', Array.from(needed), userMap, base.ownPlainId);

        const resolveUser = (plainId: string) => userMap.get(plainId) || undefined;
        const messages: ImportedZaloMessage[] = [];
        for (const m of batch) {
            const converted = toZaloMessage(m, { ...base, resolveUser });
            if (converted) messages.push(converted);
        }
        stats.messagesSkipped += batch.length - messages.length;
        if (messages.length) {
            const res = EventBroadcaster.withBossDb(db => db.saveHistoryMessagesBulk(session.zaloId, messages));
            stats.messagesImported += res.inserted;
            stats.messagesSkipped += res.ignored; // đã có sẵn (realtime / lần đồng bộ trước)
            for (const threadId of res.threads) touched.set(threadId, base.thread.isGroup);
        }
        await new Promise(resolve => setImmediate(resolve));
    }

    /** Đổi plain → noise qua API znoise (theo lô), lưu cache vào DB. ID không đổi được → '' (chỉ trong phiên). */
    private async resolveNoiseIds(
        api: MobileSyncApi, session: SyncSession, kind: 'user' | 'group', plainIds: string[],
        cache: Map<string, string>, ownPlainId: string,
    ): Promise<void> {
        const missing = Array.from(new Set(plainIds)).filter(id => /^\d+$/.test(id) && id !== ownPlainId && !cache.has(id));
        for (let i = 0; i < missing.length; i += NOISE_BATCH_SIZE) {
            this.throwIfCancelled(session);
            const chunk = missing.slice(i, i + NOISE_BATCH_SIZE);
            const res = await this.withRetry(() => api.getNoisedIds(kind === 'user' ? { uids: chunk, gids: [] } : { uids: [], gids: chunk }));
            const list = kind === 'user' ? res.fids : res.gids;
            const pairs: Array<[string, string]> = [];
            chunk.forEach((plainId, idx) => {
                const noiseId = list[idx] || '';
                cache.set(plainId, noiseId);
                if (noiseId) pairs.push([plainId, noiseId]);
            });
            EventBroadcaster.withBossDb(db => db.savePlainIdMappings(session.zaloId, kind, pairs));
        }
    }

    private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
        let lastErr: any;
        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
        throw new Error(`Không đổi được ID hội thoại từ điện thoại: ${lastErr?.message || lastErr}`);
    }

    /** Hội thoại chỉ có trên điện thoại (chưa có tên) → lấy tên/ảnh đại diện để danh sách hiển thị đúng. */
    private async refreshMissingProfiles(api: any, zaloId: string, touched: Map<string, boolean>): Promise<void> {
        const ids = EventBroadcaster.withBossDb(db => db.getContactIdsWithoutProfile(zaloId, Array.from(touched.keys())));
        const users = ids.filter(id => !touched.get(id)).slice(0, MAX_PROFILE_LOOKUPS);
        const groups = ids.filter(id => touched.get(id)).slice(0, MAX_PROFILE_LOOKUPS);
        for (let i = 0; i < users.length; i += PROFILE_BATCH_SIZE) {
            const chunk = users.slice(i, i + PROFILE_BATCH_SIZE);
            try {
                const res: any = await api.getUserInfo(chunk);
                const profiles = res?.changed_profiles || {};
                EventBroadcaster.withBossDb(db => {
                    for (const id of chunk) {
                        const p = profiles[id] || profiles[`${id}_0`];
                        const name = p?.displayName || p?.zaloName || '';
                        if (name) db.updateContactProfile(zaloId, id, name, p?.avatar || '', '', 'user');
                    }
                });
            } catch (err: any) {
                Logger.warn(`[MobileSync] ${zaloId}: getUserInfo lỗi: ${err?.message}`);
            }
        }
        for (let i = 0; i < groups.length; i += PROFILE_BATCH_SIZE) {
            const chunk = groups.slice(i, i + PROFILE_BATCH_SIZE);
            try {
                const res: any = await api.getGroupInfo(chunk);
                const infos = res?.gridInfoMap || {};
                EventBroadcaster.withBossDb(db => {
                    for (const id of chunk) {
                        const g = infos[id];
                        if (g?.name) db.updateContactProfile(zaloId, id, g.name, g.avt || g.fullAvt || '', '', 'group');
                    }
                });
            } catch (err: any) {
                Logger.warn(`[MobileSync] ${zaloId}: getGroupInfo lỗi: ${err?.message}`);
            }
        }
    }

    // ─── Trạng thái / tiện ích ───────────────────────────────────────────────

    private currentApi(zaloId: string): any {
        const api = ConnectionManager.getConnection(zaloId)?.api;
        if (!api) throw new Error('Tài khoản đã mất kết nối');
        return installMobileSyncApis(api);
    }

    private async cancelOnServer(session: SyncSession): Promise<void> {
        if (!WAITING_STAGES.includes(session.status.stage)) return;
        try {
            await this.currentApi(session.zaloId).cancelPullMobile({ public_key: session.publicKey, pc_name: session.pcName });
        } catch (err: any) {
            Logger.warn(`[MobileSync] ${session.zaloId}: cancel_pull_mobile_msg lỗi: ${err?.message}`);
        }
    }

    private armTimeout(session: SyncSession, ms: number, message: string): void {
        this.clearTimer(session);
        session.timer = setTimeout(() => {
            session.timer = null;
            if (!WAITING_STAGES.includes(session.status.stage) || session.importing) return;
            void this.cancelOnServer(session).finally(() => this.fail(session, message));
        }, ms);
    }

    private clearTimer(session: SyncSession): void {
        if (session.timer) clearTimeout(session.timer);
        session.timer = null;
    }

    private throwIfCancelled(session: SyncSession): void {
        if (session.cancelled) throw new MobileSyncCancelled();
    }

    private setStage(session: SyncSession, stage: MobileSyncStage, message: string): void {
        session.status = { ...session.status, stage, message, progress: 0, updatedAt: Date.now() };
        this.emit(session, true);
    }

    private setProgress(session: SyncSession, progress: number): void {
        const value = Math.max(0, Math.min(100, Math.round(progress)));
        if (value === session.status.progress) return;
        session.status = { ...session.status, progress: value, updatedAt: Date.now() };
        this.emit(session, value === 100);
    }

    private fail(session: SyncSession, error: string, stats?: MobileSyncStats): void {
        this.finish(session, 'failed', error, stats, error);
    }

    private finish(session: SyncSession, stage: MobileSyncStage, message: string, stats?: MobileSyncStats, error?: string): void {
        this.clearTimer(session);
        session.privateKey = '';
        session.status = {
            ...session.status,
            stage,
            message,
            error,
            stats,
            progress: stage === 'completed' ? 100 : session.status.progress,
            updatedAt: Date.now(),
        };
        this.emit(session, true);
    }

    private emit(session: SyncSession, force: boolean): void {
        const now = Date.now();
        if (!force && now - session.lastEmitAt < PROGRESS_THROTTLE_MS) return;
        session.lastEmitAt = now;
        EventBroadcaster.emit(MOBILE_SYNC_EVENT, session.status);
    }
}

export default MobileSyncService;
