/**
 * MobileSyncService - "Đồng bộ tin nhắn từ điện thoại" (sync messages from phone) for a Zalo account.
 *
 * Flow (same as Zalo PC/Web):
 *   pullMobile(public_key) → the phone asks the user → control event syncmsgmb:
 *     user_confirm → (transfer_error status 1/2: preparing / phone is asleep) → syncmsg_info {url, encrypted_key}
 *   → download `.db.crypt` → RSA-decrypt the key → decrypt + decompress ZDB4.0 → SQLite files `<uid>.db` / `group_<gid>.db`
 *   → convert the mobile (plain) IDs to web (noise) IDs with the znoise API → bulk-save into the messages table.
 *
 * Thanks to znoise, the history messages land in the RIGHT existing conversation (same thread_id as realtime messages), with no need to
 * guess msgId correlations the way the earlier workaround did.
 *
 * Time range: the user picks it in the modal (default: the most recent 1 week). `fromTs` is sent to the phone
 * as `from_seq_id` (how Zalo PC asks for "new messages only") and both ends are filtered in the SQL query when the backup is read,
 * so if the phone sends extra, messages outside the range are not read / imported.
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
import { tr, appLocale } from '../../../shared/i18n';

export const MOBILE_SYNC_EVENT = 'event:mobileSync';

const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;
const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;
/** ~1000 rows per transaction ≈ 50ms blocking the main process (measured including the FTS trigger). */
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
    /** The zca-js instance that has the listener attached for each account (each reconnect creates a new api). */
    private attachedApis = new Map<string, any>();

    public static getInstance(): MobileSyncService {
        if (!MobileSyncService.instance) MobileSyncService.instance = new MobileSyncService();
        return MobileSyncService.instance;
    }

    /** Attach the API + the sync event listener to each new zca-js instance (called when the listener is built). */
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
     * Start syncing the time range [fromTs, toTs] (ms). Not passed = the whole history on the phone.
     * Messages already in the DB are skipped (INSERT OR IGNORE), so choosing a range that overlaps the last sync is fine.
     */
    public async start(zaloId: string, request: Partial<MobileSyncRange> = {}): Promise<{ success: boolean; status?: MobileSyncStatus; error?: string }> {
        const fromTs = positiveTs(request.fromTs);
        const toTs = positiveTs(request.toTs);
        if (fromTs && toTs && fromTs > toTs) return { success: false, error: tr('Ngày bắt đầu phải trước ngày kết thúc') };
        const existing = this.sessions.get(zaloId);
        if (existing && !TERMINAL_STAGES.includes(existing.status.stage)) {
            return { success: false, status: existing.status, error: tr('Đang có một phiên đồng bộ chạy cho tài khoản này') };
        }
        const conn = ConnectionManager.getConnection(zaloId);
        if (!conn?.api || !conn.connected) return { success: false, error: tr('Tài khoản không online') };
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
                message: tr('Đang gửi yêu cầu tới điện thoại...'),
                pcName: DEFAULT_SYNC_PC_NAME,
                range: { fromTs, toTs },
                startedAt: now,
                updatedAt: now,
            },
        };
        this.sessions.set(zaloId, session);
        this.emit(session, true);

        try {
            // Hint to the phone to send only messages from fromTs (Zalo PC: from_seq_id = maxSeq + 1, "seq" = TimeStamp ms).
            // If the phone ignores the hint, the backup is still filtered to [fromTs, toTs] when it is read.
            await api.pullMobile({ public_key: publicKey, pc_name: session.pcName, from_seq_id: fromTs ?? 0, min_seq_id: 0 });
        } catch (err: any) {
            if (!session.cancelled) this.fail(session, tr('Không gửi được yêu cầu đồng bộ: {{v1}}', { v1: err?.message || err }));
            return { success: false, status: session.status, error: session.status.error };
        }
        if (session.cancelled) return { success: false, status: session.status, error: tr('Đã huỷ') };

        Logger.log(`[MobileSync] ${zaloId}: đã gửi pull_mobile_msg (from_seq_id=${fromTs ?? 0}, khoảng ${fmtTs(fromTs)} → ${fmtTs(toTs)}), chờ xác nhận trên điện thoại`);
        this.setStage(session, 'waiting_confirm', tr('Mở Zalo trên điện thoại và bấm "Đồng ý" để đồng bộ tin nhắn sang máy tính'));
        this.armTimeout(session, CONFIRM_TIMEOUT_MS, tr('Hết thời gian chờ xác nhận trên điện thoại'));
        return { success: true, status: session.status };
    }

    public async cancel(zaloId: string): Promise<{ success: boolean; status?: MobileSyncStatus }> {
        const session = this.sessions.get(zaloId);
        if (!session || TERMINAL_STAGES.includes(session.status.stage)) return { success: true, status: session?.status };
        session.cancelled = true;
        this.clearTimer(session);
        if (!session.importing) {
            await this.cancelOnServer(session);
            this.finish(session, 'cancelled', tr('Đã huỷ đồng bộ'));
        }
        // While downloading / decrypting / importing → the loop stops at the next step and then switches to 'cancelled'.
        return { success: true, status: session.status };
    }

    // ─── Events from the phone ───────────────────────────────────────────────

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
                    this.setStage(session, 'waiting_backup', tr('Điện thoại đang chuẩn bị dữ liệu tin nhắn, vui lòng giữ Zalo mở trên điện thoại...'));
                    this.armTimeout(session, BACKUP_TIMEOUT_MS, tr('Hết thời gian chờ điện thoại gửi dữ liệu'));
                } else if (action === 0) {
                    this.finish(session, 'cancelled', tr('Bạn đã từ chối đồng bộ trên điện thoại'));
                } else if (action === 2) {
                    this.fail(session, tr('Điện thoại đang khôi phục dữ liệu, vui lòng thử lại sau'));
                }
                break;
            }
            case SyncEventType.TRANSFER_ERROR: {
                const status = Number(data.status);
                const errorCode = Number(data.error_code || 0);
                if (status === 1) {
                    this.setStage(session, 'waiting_backup', tr('Điện thoại đang chuẩn bị dữ liệu tin nhắn, vui lòng giữ Zalo mở trên điện thoại...'));
                    this.armTimeout(session, BACKUP_TIMEOUT_MS, tr('Hết thời gian chờ điện thoại gửi dữ liệu'));
                } else if (status === 2) {
                    this.setStage(session, 'mobile_idle', tr('Điện thoại đang tạm dừng — mở Zalo trên điện thoại để tiếp tục đồng bộ'));
                    this.armTimeout(session, BACKUP_TIMEOUT_MS, tr('Hết thời gian chờ điện thoại gửi dữ liệu'));
                } else if (errorCode !== 0) {
                    this.fail(session, tr('Điện thoại không tạo được bản sao lưu (mã {{error_code}}{{v1}})', { error_code: data.error_code, v1: data.error_msg ? `: ${data.error_msg}` : '' }));
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

    // ─── Download + decrypt + import ────────────────────────────────────────────────

    private async runImport(session: SyncSession, info: TSyncEventSyncMsgInfo): Promise<void> {
        const startedAt = Date.now();
        const workDir = path.join(app.getPath('userData'), 'mobile-sync', session.zaloId, String(startedAt));
        const stats = emptyStats();
        // The final status is only sent AFTER the temp files are cleaned up (so "Đồng bộ lại" (sync again) does not overlap the cleanup step).
        let settle: () => void;
        try {
            const api = this.currentApi(session.zaloId);
            const dbInfo = this.parseDbInfo(info.db_info);
            // Number of messages the phone sent: compared with the chosen range to tell whether the phone sent only the new ones (from_seq_id).
            Logger.log(`[MobileSync] ${session.zaloId}: bản sao lưu db_info=${JSON.stringify(dbInfo)} file_size=${info.file_size ?? '?'}`);
            const format = dbInfo.db_format ?? 0;
            if (format !== 1) {
                throw new Error(tr('Định dạng sao lưu chưa được hỗ trợ (db_format={{format}}). Hãy cập nhật Zalo trên điện thoại rồi thử lại.', { format }));
            }
            // Same as Zalo PC: origin_db (if present) takes priority over backup_db; msg_total = 0 → nothing to import.
            const counts = dbInfo.origin_db || dbInfo.backup_db;
            if (counts && Number(counts.msg_total) === 0) {
                settle = () => this.finish(session, 'completed', session.status.range?.fromTs
                    ? tr('Điện thoại không có tin nhắn nào trong khoảng thời gian đã chọn')
                    : tr('Điện thoại không có tin nhắn nào để đồng bộ'), stats);
                return;
            }

            await fs.promises.mkdir(workDir, { recursive: true });
            const cryptPath = path.join(workDir, 'backup.db.crypt');
            this.setStage(session, 'downloading', tr('Đang tải dữ liệu từ máy chủ Zalo...'));
            await this.downloadBackup(api, session, info, cryptPath);

            const checksumOk = await verifyChecksum(cryptPath, info.checksum_code || info.checksum);
            if (checksumOk === false) Logger.warn(`[MobileSync] ${session.zaloId}: checksum không khớp, vẫn thử giải mã`);
            this.throwIfCancelled(session);

            this.setStage(session, 'decrypting', tr('Đang giải mã dữ liệu tin nhắn...'));
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
            const rangeNote = session.status.range?.fromTs || session.status.range?.toTs ? tr(' trong khoảng thời gian đã chọn') : '';
            settle = () => this.finish(session, 'completed',
                tr('Đã đồng bộ {{v1}} tin nhắn mới từ {{conversationsResolved}} hội thoại{{rangeNote}}', { v1: stats.messagesImported.toLocaleString(appLocale()), conversationsResolved: stats.conversationsResolved, rangeNote }),
                stats);
        } catch (err: any) {
            stats.durationMs = Date.now() - startedAt;
            if (session.cancelled || err instanceof MobileSyncCancelled || err?.name === 'AbortError') {
                settle = () => this.finish(session, 'cancelled', tr('Đã huỷ đồng bộ'), stats);
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
            throw new Error(tr('Thông tin bản sao lưu từ điện thoại không hợp lệ'));
        }
    }

    private async downloadBackup(api: any, session: SyncSession, info: TSyncEventSyncMsgInfo, destPath: string): Promise<void> {
        const ctx = api.getContext();
        // Zalo PC sends all session cookies of the auth domain; for a web session (zca-js) that is the chat.zalo.me cookie.
        let sessionCookie = '';
        try {
            sessionCookie = await ctx.cookie.getCookieString('https://chat.zalo.me/');
        } catch { /* download without cookies */ }
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
        // `<own uid>.db` = the conversation with yourself (thread = account ID). Zalo's "My Documents" is a
        // private conversation (send2me ID, folder picture) → mapped like every 1-1 conversation through the ID mapping table, with no extra naming.
        const threads = files
            .map(file => ({ file, ref: parseThreadFileName(file.name) }))
            .filter(t => t.ref !== null);
        stats.conversations = threads.length;

        this.setStage(session, 'resolving_ids', tr('Đang ghép hội thoại với tài khoản trên máy tính...'));
        const userMap = EventBroadcaster.withBossDb(db => db.getPlainIdMappings(zaloId, 'user'));
        const groupMap = EventBroadcaster.withBossDb(db => db.getPlainIdMappings(zaloId, 'group'));
        await this.resolveNoiseIds(api, session, 'user', threads.filter(t => !t.ref.isGroup).map(t => t.ref.plainId), userMap, ownPlainId);
        await this.resolveNoiseIds(api, session, 'group', threads.filter(t => t.ref.isGroup).map(t => t.ref.plainId), groupMap, ownPlainId);

        this.setStage(session, 'importing', tr('Đang ghép tin nhắn vào các hội thoại...'));
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
            stats.messagesSkipped += res.ignored; // already there (realtime / previous sync)
            for (const threadId of res.threads) touched.set(threadId, base.thread.isGroup);
        }
        await new Promise(resolve => setImmediate(resolve));
    }

    /** Convert plain → noise through the znoise API (in batches) and cache it in the DB. IDs that cannot be converted → '' (this session only). */
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
        throw new Error(tr('Không đổi được ID hội thoại từ điện thoại: {{v1}}', { v1: lastErr?.message || lastErr }));
    }

    /** Conversations that only exist on the phone (no name yet) → fetch the name / avatar so the list shows them correctly. */
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

    // ─── Status / helpers ───────────────────────────────────────────────

    private currentApi(zaloId: string): any {
        const api = ConnectionManager.getConnection(zaloId)?.api;
        if (!api) throw new Error(tr('Tài khoản đã mất kết nối'));
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
