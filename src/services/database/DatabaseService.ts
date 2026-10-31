import * as path from 'path';
import * as fs from 'fs';
import { app, safeStorage } from 'electron';
import Logger from '../../utils/Logger';
import { FB_TEMPLATE_MSG_TYPE, fbTemplateFromAttachments, fbTemplateText, isFbUnavailableTemplate, shouldUpgradeFbTemplate } from '../../shared/facebook/facebookTemplate';
import BetterSqlite3 from 'better-sqlite3';
import type { Account, Message, Contact, CRMNote, CRMCampaign, CRMCampaignContact, CRMSendLog, CRMCampaignStatus, CRMContactStatus } from '../../models';
import type { TelegramPeer } from '../../models/telegram/telegram';
import { CHANNEL } from '../../ui/lib/channels/channelHelper';
import { getTelegramMessagePreview } from '../telegram/messages/TelegramMessagePreview';
import { normalizeZaloPhotoContent, toZaloJpgUrl } from '../../utils/zalo/zaloImageUrl';
import FileStorageService from '../file/FileStorageService';
import { searchPickerContacts, PickerContactRow, PickerSearchOptions, PickerSearchResult } from '../../shared/workflow/contactPickerSearch';
import { addLocalDays, localDayBuckets, localDayDiff, localDayKey, localHourBuckets, sqlLocalDay, sqlLocalHour } from '../../shared/analytics/localTimeBuckets';
import { MEDIA_MESSAGE_COLUMNS, MEDIA_MESSAGE_FILTER, buildMediaCursorQuery, type MediaCursor } from './mediaMessagesQuery';
import { escapeLikePattern, foldSearchText } from '../../shared/chat/searchFold';
import { buildMessageFtsQuery, MESSAGE_SEARCH_FTS_CANDIDATES, MESSAGE_SEARCH_LIMIT, MESSAGE_SEARCH_RECENT_SCAN } from '../../shared/chat/messageSearch';
import { createCRMContactFilter, hasCRMContactFilters, type CRMContactFilters } from '../../shared/crm/crmContactFilters';
import { mergeZaloReactionAliases, normalizeZaloReactionEmoji } from '../../shared/zalo/zaloReactions';
import { zinstantPreviewText } from '../../shared/zalo/zaloZinstant';
import { contactReplyStateSql } from '../../shared/chat/replyState';
import { ZALO_TTL_EXPIRY_GRACE_MS, isZaloTtlExpired } from '../../shared/zalo/zaloAutoDelete';
import { TELEGRAM_TOP_MESSAGE_ID_SQL, telegramTopMessageIdParams } from './telegramTopMessage';

// better-sqlite3: native SQLite - no WASM heap, memory-mapped I/O
let db: BetterSqlite3.Database | null = null;
/** Câu lệnh tra tin Zalo theo cliMsgId (findZaloRowByCli) — mỗi kết nối DB một bản. */
const zaloCliLookupStatements = new WeakMap<BetterSqlite3.Database, BetterSqlite3.Statement>();

// ── Cached secondary DB for withDbPath (avoids repeated open/close) ─────────
let _cachedSecondaryDb: BetterSqlite3.Database | null = null;
let _cachedSecondaryPath: string | null = null;
let _cachedSecondaryTimer: ReturnType<typeof setTimeout> | null = null;
const SECONDARY_DB_TTL_MS = 30_000; // auto-close after 30s idle
/** markAsRead: số tin mới nhất của hội thoại được đánh dấu 'read' (giữ lệnh mở hội thoại ở mức vài ms). */
const MARK_READ_SCOPE = 200;
/** getLinks: hội thoại (theo DB) đã bù link từ tin cũ trong phiên này. */
const linksBackfilledThreads = new Set<string>();
/**
 * Điều kiện "cùng hội thoại" khi tra tin theo msg_id / cli_msg_id. Viết `thread_id = ?` thì SQLite (DB chưa ANALYZE) chọn
 * idx_messages_thread(_cursor) (owner, thread_id) và QUÉT CẢ HỘI THOẠI để tìm một tin: đo 390 ms / lần trên hội thoại
 * 99k tin — lúc mở app, trích dẫn chưa có tin gốc tra từng tin (getMessageById) chiếm ~13 s luồng chính. CAST giữ đúng
 * phép so sánh của cột TEXT (tham số số vẫn khớp, khác `+thread_id`) nhưng không dùng được index theo thread → SQLite tra
 * index msg_id (UNIQUE) / idx_messages_cli rồi lọc hội thoại (0,3 ms). Điều kiện OR msg_id / cli_msg_id thì tách 2 lần
 * tra: OR + CAST làm SQLite quét mọi tin của tài khoản.
 */
const SAME_THREAD_SQL = 'CAST(thread_id AS TEXT) = ?';
/** last_message_time theo mili-giây (bản ghi cũ lưu giây). */
const CONTACT_LAST_MS_SQL = `(CASE WHEN last_message_time > 0 AND last_message_time < 100000000000 THEN last_message_time * 1000 ELSE last_message_time END)`;
/**
 * Ghi một thành viên nhóm: tên / ảnh / vai trò lấy bản mới như trước; @username mới rỗng (nơi gọi không có — Zalo, lịch
 * sử tin, quét thành viên) thì GIỮ @username đã lưu. Trước đây INSERT OR REPLACE xoá mất @username của Telegram nên ô
 * @nhắc đến phải hỏi lại từng người qua API mỗi lần gõ @.
 */
const GROUP_MEMBER_UPSERT_SQL = `
    INSERT INTO page_group_member
        (owner_zalo_id, group_id, member_id, display_name, avatar, role, username, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_zalo_id, group_id, member_id) DO UPDATE SET
        display_name = excluded.display_name,
        avatar = excluded.avatar,
        role = excluded.role,
        username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE page_group_member.username END,
        updated_at = excluded.updated_at`;

function getCachedSecondaryDb(targetDbPath: string): BetterSqlite3.Database {
    if (_cachedSecondaryPath === targetDbPath && _cachedSecondaryDb) {
        // Reset idle timer
        if (_cachedSecondaryTimer) clearTimeout(_cachedSecondaryTimer);
        _cachedSecondaryTimer = setTimeout(closeCachedSecondaryDb, SECONDARY_DB_TTL_MS);
        return _cachedSecondaryDb;
    }
    // Close previous if different path
    closeCachedSecondaryDb();
    _cachedSecondaryDb = new BetterSqlite3(targetDbPath);
    _cachedSecondaryDb.pragma('journal_mode = WAL');
    _cachedSecondaryPath = targetDbPath;
    _cachedSecondaryTimer = setTimeout(closeCachedSecondaryDb, SECONDARY_DB_TTL_MS);
    return _cachedSecondaryDb;
}

function closeCachedSecondaryDb(): void {
    if (_cachedSecondaryTimer) { clearTimeout(_cachedSecondaryTimer); _cachedSecondaryTimer = null; }
    if (_cachedSecondaryDb) {
        try { _cachedSecondaryDb.close(); } catch {}
        _cachedSecondaryDb = null;
        _cachedSecondaryPath = null;
    }
}

/**
 * Accounts of an analytics query: one zaloId (every existing caller) or several (Reports with a
 * multi-account selection). Trimmed, empty ids dropped, de-duplicated, order kept.
 */
function analyticsAccountIds(zaloIds: string | string[] | null | undefined): string[] {
    const list = Array.isArray(zaloIds) ? zaloIds : [zaloIds];
    return Array.from(new Set(list.map(id => String(id ?? '').trim()).filter(Boolean)));
}

/** `column = ?` for one account (the single-account SQL, unchanged), `column IN (?, ...)` for several. */
function sqlAccountFilter(column: string, ids: string[]): string {
    return ids.length === 1 ? `${column} = ?` : `${column} IN (${ids.map(() => '?').join(', ')})`;
}

/**
 * Optional account filter on employee_message_log.zalo_id (Reports → Nhân viên).
 * null/undefined = every account (the report before the filter existed); [] = no account.
 */
function employeeLogAccountFilter(zaloIds?: string[] | null): { sql: string; params: string[] } {
    if (!Array.isArray(zaloIds)) return { sql: '', params: [] };
    const ids = analyticsAccountIds(zaloIds);
    if (ids.length === 0) return { sql: ' AND 1 = 0', params: [] };
    return { sql: ` AND ${sqlAccountFilter('zalo_id', ids)}`, params: ids };
}

/**
 * Kết quả saveFBMessage: `new` = hàng mới; `repaired` = hàng đã có (bản tới trước từ nguồn khác) còn rỗng / là thẻ
 * "File đính kèm không hiển thị" và lần này được sửa; `duplicate` = hàng đã có, không đổi gì (MQTT và bridge cùng nhận
 * một tin, hoặc phát lại).
 */
export type FbSaveOutcome = 'new' | 'repaired' | 'duplicate';

class DatabaseService {
    private static instance: DatabaseService;
    private dbPath: string = '';
    private initialized = false;

    /** Open a better-sqlite3 database at the given path with WAL mode */
    private openDb(dbPath: string): BetterSqlite3.Database {
        const newDb = new BetterSqlite3(dbPath);
        newDb.pragma('journal_mode = WAL');
        newDb.pragma('synchronous = NORMAL');
        return newDb;
    }

    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    public async initialize(): Promise<void> {
        try {
            const userDataPath = app.getPath('userData');
            Logger.log(`[DatabaseService] userData path: ${userDataPath}`);

            // ─── Workspace-aware DB path resolution ─────────────────────
            let resolvedViaWorkspace = false;
            try {
                const WorkspaceManager = require('../../utils/app/WorkspaceManager').default;
                const wm = WorkspaceManager.getInstance();
                const activeDbPath = wm.getActiveDbPath();
                if (activeDbPath) {
                    this.dbPath = activeDbPath;
                    resolvedViaWorkspace = true;
                    Logger.log(`[DatabaseService] DB path from WorkspaceManager: ${this.dbPath}`);
                }
            } catch { /* WorkspaceManager not yet initialized - fall back to legacy */ }

            if (!resolvedViaWorkspace) {
                let dbFolder = userDataPath;
                const configPath = path.join(userDataPath, 'deplao-config.json');
                if (fs.existsSync(configPath)) {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        if (cfg.dbFolder) {
                            if (fs.existsSync(cfg.dbFolder)) {
                                dbFolder = cfg.dbFolder;
                                Logger.log(`[DatabaseService] Using custom dbFolder from config: ${dbFolder}`);
                            } else {
                                Logger.warn(`[DatabaseService] Configured dbFolder not found: ${cfg.dbFolder} - attempting to create it`);
                                try {
                                    fs.mkdirSync(cfg.dbFolder, { recursive: true });
                                    dbFolder = cfg.dbFolder;
                                    Logger.log(`[DatabaseService] Created missing dbFolder: ${dbFolder}`);
                                } catch (mkErr: any) {
                                    Logger.error(`[DatabaseService] Cannot create dbFolder ${cfg.dbFolder}: ${mkErr.message} - falling back to userData`);
                                }
                            }
                        }
                    } catch {}
                }
                this.dbPath = path.join(dbFolder, 'deplao-tool.db');
            }

            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Open DB with better-sqlite3 (native SQLite, memory-mapped I/O)
            try {
                db = this.openDb(this.dbPath);
            } catch (openErr: any) {
                // First open failed - try recovery: clean stale WAL/SHM from crash/update
                Logger.warn(`[DatabaseService] First open failed: ${openErr.message}. Attempting WAL/SHM cleanup...`);
                const walPath = this.dbPath + '-wal';
                const shmPath = this.dbPath + '-shm';
                try { if (fs.existsSync(walPath)) fs.unlinkSync(walPath); } catch {}
                try { if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath); } catch {}
                // Retry open after cleanup
                db = this.openDb(this.dbPath);
                Logger.log(`[DatabaseService] Recovery successful after WAL/SHM cleanup`);
            }

            this.createTables();
            this.migrate();
            this.migrateFTS5();
            this.migrateMediaLibrary();
            this.initErpSchema();
            this.initialized = true;
            this.encryptStoredCredentials();
            this.repairZaloZinstantPreviewsOnce();
            this.scheduleJxlImageRepair();
            Logger.log(`[DatabaseService] Initialized at ${this.dbPath} (better-sqlite3, WAL mode)`);
        } catch (error: any) {
            Logger.error(`[DatabaseService] Failed to initialize: ${error.message}`);
            // ⚠️ DO NOT silently fall back to in-memory DB - this causes "lost data" after updates.
            // Instead, try to show a dialog and let the user decide.
            try {
                const { dialog } = require('electron');
                const choice = dialog.showMessageBoxSync({
                    type: 'error',
                    title: 'Lỗi khởi tạo database',
                    message: 'Không thể mở file database. Dữ liệu có thể bị lỗi sau khi cập nhật.',
                    detail: `Path: ${this.dbPath}\nError: ${error.message}\n\nBạn muốn thử khôi phục không?`,
                    buttons: ['Thử khôi phục', 'Thoát'],
                    defaultId: 0,
                    cancelId: 1,
                });
                if (choice === 0) {
                    // Attempt recovery: backup corrupt DB and create fresh one
                    try {
                        const backupPath = `${this.dbPath}.corrupt-${Date.now()}.bak`;
                        if (fs.existsSync(this.dbPath)) {
                            fs.copyFileSync(this.dbPath, backupPath);
                            Logger.warn(`[DatabaseService] Backed up corrupt DB to: ${backupPath}`);
                        }
                        // Delete corrupt files
                        try { fs.unlinkSync(this.dbPath); } catch {}
                        try { fs.unlinkSync(this.dbPath + '-wal'); } catch {}
                        try { fs.unlinkSync(this.dbPath + '-shm'); } catch {}
                        // Create fresh DB
                        db = this.openDb(this.dbPath);
                        this.createTables();
                        this.migrate();
                        this.migrateFTS5();
                        this.migrateMediaLibrary();
                        this.initErpSchema();
                        this.initialized = true;
                        Logger.warn(`[DatabaseService] Created fresh DB after recovery. Backup at: ${backupPath}`);
                    } catch (recoveryErr: any) {
                        Logger.error(`[DatabaseService] Recovery also failed: ${recoveryErr.message}`);
                        app.quit();
                    }
                } else {
                    app.quit();
                }
            } catch (dialogErr: any) {
                // dialog not available (very early init), fall back to in-memory as last resort
                Logger.error(`[DatabaseService] Dialog failed, using in-memory fallback: ${dialogErr.message}`);
                try {
                    db = new BetterSqlite3(':memory:');
                    this.createTables();
                    this.migrate();
                    this.initErpSchema();
                    this.initialized = true;
                    Logger.warn(`[DatabaseService] Using in-memory database as last-resort fallback`);
                } catch (e2: any) {
                    Logger.error(`[DatabaseService] In-memory fallback also failed: ${e2.message}`);
                }
            }
        }
    }

    /** No-op: better-sqlite3 with WAL mode writes directly to disk. Kept for API compat. */
    public save(): void {
        // better-sqlite3 writes to disk automatically via WAL - nothing to do
    }

    /** No-op: better-sqlite3 auto-persists. Kept for API compat. */
    private scheduleSave(): void {
        // No-op - WAL mode auto-writes
    }

    /**
     * WAL checkpoint - ensures all writes are flushed to main DB file.
     * Call before copy/move DB file, switch workspace, or app quit.
     */
    public forceFlush(): void {
        try {
            if (db) {
                db.pragma('wal_checkpoint(TRUNCATE)');
                Logger.log(`[DatabaseService] WAL checkpoint completed for ${this.dbPath}`);
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] WAL checkpoint error: ${err.message}`);
        }
    }

    /**
     * Close the database connection and release file locks.
     * MUST be called in before-quit to ensure WAL/SHM files are released
     * before the NSIS installer runs (prevents DB corruption during updates).
     */
    public close(): void {
        try {
            if (db) {
                // Flush WAL first
                try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
                db.close();
                db = null;
                this.initialized = false;
                Logger.log(`[DatabaseService] DB closed cleanly: ${this.dbPath}`);
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] DB close error: ${err.message}`);
        }
    }

    /**
     * Reinitialize DatabaseService từ path mới (đọc lại deplao-config.json).
     * Gọi sau khi thay đổi dbFolder trong config để áp dụng ngay không cần restart.
     */
    public async reinitialize(): Promise<void> {
        Logger.log('[DatabaseService] Reinitializing from new config...');
        try { db?.close(); } catch {}
        db = null;
        this.initialized = false;
        this.dbPath = '';
        await this.initialize();
        Logger.log(`[DatabaseService] Reinitialized at ${this.dbPath}`);
    }

    /**
     * Switch DB to a different workspace's database file.
     * Closes current DB, opens the new one, runs migrations.
     * Used when user switches workspace in multi-workspace mode.
     */
    /** Lock to prevent concurrent DB access during workspace switch */
    private switching = false;
    private switchQueue: Array<{ resolve: (v: any) => void; fn: () => any }> = [];

    public async switchToWorkspaceDb(newDbPath: string): Promise<void> {
        Logger.log(`[DatabaseService] Switching DB to: ${newDbPath}`);

        const targetDbPath = path.resolve(newDbPath);
        const currentDbPath = this.dbPath ? path.resolve(this.dbPath) : '';
        if (currentDbPath && currentDbPath === targetDbPath) {
            Logger.log(`[DatabaseService] Switch skipped - already using ${targetDbPath}`);
            return;
        }

        // Set switching lock - queues any concurrent run()/query() calls
        this.switching = true;

        const prevDbPath = this.dbPath;
        const prevDb = db;

        try {
            const dir = path.dirname(targetDbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                Logger.log(`[DatabaseService] Created directory: ${dir}`);
            }

            // Close cached secondary DB (if any) before switching
            closeCachedSecondaryDb();

            // Close old DB
            try {
                prevDb?.close();
            } catch (closeErr: any) {
                Logger.warn(`[DatabaseService] Failed to close previous DB before switch: ${closeErr.message}`);
            }
            db = null;

            // Open the new DB (better-sqlite3 handles create-if-not-exists automatically)
            try {
                db = this.openDb(targetDbPath);
                Logger.log(`[DatabaseService] Opened DB: ${targetDbPath}`);
            } catch (loadErr: any) {
                const msg = loadErr?.message || String(loadErr);
                Logger.warn(`[DatabaseService] Failed to open DB (corrupt?): ${msg}. Backing up and creating fresh DB.`);
                try {
                    const backupPath = `${targetDbPath}.corrupt-${Date.now()}.bak`;
                    fs.copyFileSync(targetDbPath, backupPath);
                    Logger.warn(`[DatabaseService] Backed up corrupt DB to: ${backupPath}`);
                } catch (backupErr: any) {
                    Logger.warn(`[DatabaseService] Failed to back up corrupt DB: ${backupErr.message}`);
                }
                // Delete corrupt file and retry
                try { fs.unlinkSync(targetDbPath); } catch {}
                db = this.openDb(targetDbPath);
                Logger.log(`[DatabaseService] Created fresh DB after failed load: ${targetDbPath}`);
            }

            this.dbPath = targetDbPath;
            this.createTables();
            this.migrate();
            this.migrateFTS5();
            this.migrateMediaLibrary();
            this.initErpSchema();
            this.initialized = true;
            this.encryptStoredCredentials();
            this.repairZaloZinstantPreviewsOnce();
            this.scheduleJxlImageRepair();

            Logger.log(`[DatabaseService] Workspace DB ready at ${this.dbPath}`);
        } catch (err: any) {
            const errMsg = err?.message || String(err);
            Logger.error(`[DatabaseService] switchToWorkspaceDb failed: ${errMsg}. Rolling back to ${prevDbPath}.`);
            this.dbPath = prevDbPath;
            try {
                if (prevDbPath && fs.existsSync(prevDbPath)) {
                    db = this.openDb(prevDbPath);
                } else {
                    db = new BetterSqlite3(':memory:');
                }
                this.initialized = true;
                Logger.warn(`[DatabaseService] Restored previous DB: ${prevDbPath}`);
            } catch (restoreErr: any) {
                Logger.error(`[DatabaseService] Failed to restore previous DB: ${restoreErr.message}`);
            }
            throw new Error(`switchToWorkspaceDb failed: ${errMsg}`);
        } finally {
            this.switching = false;
            const queued = this.switchQueue.splice(0);
            for (const item of queued) {
                try { item.resolve(item.fn()); } catch (e) { item.resolve(undefined); }
            }
        }
    }

    /**
     * Temporarily switch to a different DB file, run a synchronous callback,
     * then switch back. Used by EmployeeService to access the relay workspace DB.
     * @deprecated Use queryOtherDb() instead - withDbPath swaps the global db and is unsafe with concurrent IPC.
     */
    public withDbPath<T>(targetDbPath: string, fn: () => T): T {
        const currentPath = this.dbPath;
        const currentDb = db;
        if (currentPath === targetDbPath) {
            return fn();
        }
        try {
            db = getCachedSecondaryDb(targetDbPath);
            this.dbPath = targetDbPath;
            const result = fn();
            return result;
        } finally {
            db = currentDb;
            this.dbPath = currentPath;
        }
    }

    /**
     * Async variant of withDbPath — awaits the callback before restoring the DB.
     * Use this when fn() is async (contains await), otherwise withDbPath restores
     * the DB before the async operations complete, causing writes to go to the
     * wrong database.
     */
    public async withDbPathAsync<T>(targetDbPath: string, fn: () => Promise<T>): Promise<T> {
        const currentPath = this.dbPath;
        const currentDb = db;
        if (currentPath === targetDbPath) {
            return fn();
        }
        try {
            db = getCachedSecondaryDb(targetDbPath);
            this.dbPath = targetDbPath;
            const result = await fn();
            return result;
        } finally {
            db = currentDb;
            this.dbPath = currentPath;
        }
    }

    /**
     * Execute a callback against a SEPARATE DB instance - does NOT swap the global db.
     * Safe for use from relay/socket handlers that may run concurrently with IPC.
     */
    public queryOtherDb<T>(targetDbPath: string, fn: (otherDb: any) => T): T {
        const resolvedPath = path.resolve(targetDbPath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`DB file not found: ${resolvedPath}`);
        }
        const otherDb = new BetterSqlite3(resolvedPath, { readonly: false });
        otherDb.pragma('journal_mode = WAL');
        try {
            return fn(otherDb);
        } finally {
            try { otherDb.close(); } catch {}
        }
    }

    public exec(sql: string): void {
        db!.exec(sql);
    }

    public run(sql: string, params: any[] = []): void {
        try {
            db!.prepare(sql).run(...params);
        } catch (err: any) {
            // Do not log parameter values: they can contain message text,
            // tokens, or contact data. Counts still identify missing binds.
            const placeholderCount = (sql.match(/\?/g) || []).length;
            Logger.error(
                `[DatabaseService] Run error: ${err.message} | ` +
                `placeholders=${placeholderCount} params=${params.length} | SQL: ${sql}`,
            );
            throw err;
        }
    }

    /** Execute SQL without flushing to disk - same as run() now (WAL auto-writes) */
    private runNoSave(sql: string, params: any[] = []): void {
        db!.prepare(sql).run(...params);
    }

    /** Run an INSERT and return the new rowid. */
    public runInsert(sql: string, params: any[] = []): number {
        const result = db!.prepare(sql).run(...params);
        return Number(result.lastInsertRowid) || 0;
    }

    /** Run a statement and return how many rows it changed. */
    public runChanges(sql: string, params: any[] = []): number {
        return Number(db!.prepare(sql).run(...params).changes) || 0;
    }

    /**
     * Run `fn` inside a SQLite transaction. Returns whatever `fn` returns.
     * Uses better-sqlite3 native transaction → automatic ROLLBACK on throw.
     */
    public transaction<T>(fn: () => T): T {
        return db!.transaction(fn)();
    }

    public query<T>(sql: string, params: any[] = []): T[] {
        try {
            return db!.prepare(sql).all(...params) as T[];
        } catch (err: any) {
            Logger.error(`[DatabaseService] Query error: ${err.message} | SQL: ${sql}`);
            return [];
        }
    }

    queryOne<T>(sql: string, params: any[] = []): T | undefined {
        try {
            return db!.prepare(sql).get(...params) as T | undefined;
        } catch (err: any) {
            Logger.error(`[DatabaseService] QueryOne error: ${err.message} | SQL: ${sql}`);
            return undefined;
        }
    }

    /** Chuẩn hóa số điện thoại VN trước khi lưu DB: +84/84 -> 0 */
    private normalizeVietnamPhone(phone?: string): string {
        if (!phone) return '';
        const cleaned = String(phone).trim().replace(/[\s().-]/g, '');
        if (!cleaned) return '';
        if (cleaned.startsWith('+84')) {
            const local = cleaned.slice(3).replace(/^0+/, '');
            return `0${local}`;
        }
        if (cleaned.startsWith('84')) {
            const local = cleaned.slice(2).replace(/^0+/, '');
            return `0${local}`;
        }
        return cleaned;
    }

    private normalizeWorkflowChannel(channel?: string): 'zalo' | 'facebook' {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { normalizeChannel } = require('../../configs/channels/channelConfig');
        return normalizeChannel(channel) as 'zalo' | 'facebook';
    }

    private createTables(): void {
        this.exec(`
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                zalo_id TEXT UNIQUE NOT NULL,
                full_name TEXT NOT NULL DEFAULT '',
                avatar_url TEXT DEFAULT '',
                imei TEXT NOT NULL,
                user_agent TEXT NOT NULL,
                cookies TEXT NOT NULL,
                is_active INTEGER DEFAULT 1,
                is_business INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                last_seen TEXT,
                listener_active INTEGER DEFAULT 1
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                msg_id TEXT NOT NULL,
                cli_msg_id TEXT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL DEFAULT 0,
                sender_id TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                msg_type TEXT NOT NULL DEFAULT 'text',
                timestamp INTEGER NOT NULL,
                is_sent INTEGER DEFAULT 0,
                attachments TEXT DEFAULT '[]',
                local_paths TEXT DEFAULT '{}',
                status TEXT DEFAULT 'received',
                is_recalled INTEGER DEFAULT 0,
                recalled_content TEXT DEFAULT NULL,
                recalled_msg_type TEXT DEFAULT NULL,
                topic_id TEXT DEFAULT NULL,
                UNIQUE(msg_id, owner_zalo_id)
            );
            CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(owner_zalo_id, thread_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_messages_owner_timestamp ON messages(owner_zalo_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_messages_owner_type_timestamp ON messages(owner_zalo_id, thread_type, timestamp);
            CREATE INDEX IF NOT EXISTS idx_messages_thread_cursor ON messages(owner_zalo_id, thread_id, timestamp DESC, msg_id DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_cli ON messages(owner_zalo_id, cli_msg_id) WHERE cli_msg_id IS NOT NULL;
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                avatar_url TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                is_friend INTEGER DEFAULT 0,
                contact_type TEXT DEFAULT 'user',
                unread_count INTEGER DEFAULT 0,
                last_message TEXT DEFAULT '',
                last_message_time INTEGER DEFAULT 0,
                UNIQUE(owner_zalo_id, contact_id)
            );
        `);

        // Telegram MTProto requires an access hash for most peer operations.
        // Keep this separate from contacts: group members and resolved peers
        // must not become conversation rows merely to retain their identity.
        this.exec(`
            CREATE TABLE IF NOT EXISTS telegram_peers (
                owner_zalo_id TEXT NOT NULL,
                peer_id TEXT NOT NULL,
                peer_type TEXT NOT NULL DEFAULT 'user',
                access_hash TEXT DEFAULT '',
                username TEXT DEFAULT '',
                display_name TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                avatar_url TEXT DEFAULT '',
                updated_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (owner_zalo_id, peer_id)
            );
            CREATE INDEX IF NOT EXISTS idx_telegram_peers_type
                ON telegram_peers(owner_zalo_id, peer_type, updated_at);
        `);

        // Quản trị viên của nhóm Telegram + chức vụ tự đặt (rank) — nhãn ở góc phải dòng tên người gửi. Bảng riêng, chỉ
        // getGroupAdmins ghi (thay cả nhóm mỗi lần): page_group_member bị ghi đè bằng INSERT OR REPLACE ở nhiều nơi.
        this.exec(`
            CREATE TABLE IF NOT EXISTS telegram_group_admins (
                owner_zalo_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                member_id TEXT NOT NULL,
                role INTEGER NOT NULL DEFAULT 2,
                rank TEXT NOT NULL DEFAULT '',
                updated_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (owner_zalo_id, group_id, member_id)
            );
        `);

        // MTProto global update cursor. This is deliberately separate from
        // per-dialog message history: Difference also carries edits, deletes,
        // typing and other updates that have no message timestamp.
        this.exec(`
            CREATE TABLE IF NOT EXISTS telegram_update_state (
                owner_zalo_id TEXT PRIMARY KEY,
                pts INTEGER NOT NULL DEFAULT 0,
                qts INTEGER NOT NULL DEFAULT 0,
                date INTEGER NOT NULL DEFAULT 0,
                seq INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
        `);

        // Per-channel pts for channel/supergroup update sync.
        // Each channel/supergroup has its own pts independent of the global pts.
        // Required for updates.GetChannelDifference after reconnect.
        this.exec(`
            CREATE TABLE IF NOT EXISTS telegram_channel_pts (
                owner_zalo_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                pts INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (owner_zalo_id, channel_id)
            );
        `);

        // Persistent channel recovery queue. Survives app restart so channels
        // that were mid-recovery continue draining after relaunch.
        this.exec(`
            CREATE TABLE IF NOT EXISTS telegram_channel_recovery_queue (
                owner_zalo_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                access_hash TEXT DEFAULT '',
                pts INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                last_msg_id INTEGER DEFAULT 0,
                history_start_msg_id INTEGER DEFAULT NULL,
                retry_at INTEGER DEFAULT 0,
                attempts INTEGER DEFAULT 0,
                last_error TEXT DEFAULT '',
                priority INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (owner_zalo_id, channel_id)
            );
            CREATE INDEX IF NOT EXISTS idx_recovery_queue_status
                ON telegram_channel_recovery_queue(owner_zalo_id, status, priority DESC, retry_at);
        `);

        // Bot API durable cursor: one row per bot token (hashed).
        const recoveryColumns = this.query<any>('PRAGMA table_info(telegram_channel_recovery_queue)');
        if (!recoveryColumns.some(column => column.name === 'history_start_msg_id')) {
            this.exec('ALTER TABLE telegram_channel_recovery_queue ADD COLUMN history_start_msg_id INTEGER DEFAULT NULL');
        }

        // Prevents replay on restart and ensures exactly one consumer per token.
        this.exec(`
            CREATE TABLE IF NOT EXISTS telegram_bot_cursor (
                bot_token_hash TEXT PRIMARY KEY,
                offset_value INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `);


        this.exec(`
            CREATE TABLE IF NOT EXISTS friends (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                updated_at INTEGER DEFAULT 0,
                UNIQUE(owner_zalo_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_friends_owner ON friends(owner_zalo_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                url TEXT NOT NULL,
                title TEXT DEFAULT '',
                domain TEXT DEFAULT '',
                thumb_url TEXT DEFAULT '',
                timestamp INTEGER NOT NULL,
                UNIQUE(owner_zalo_id, msg_id)
            );
            CREATE INDEX IF NOT EXISTS idx_links_thread ON links(owner_zalo_id, thread_id, timestamp);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS page_group_member (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                member_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                role INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0,
                UNIQUE(owner_zalo_id, group_id, member_id)
            );
            CREATE INDEX IF NOT EXISTS idx_group_member ON page_group_member(owner_zalo_id, group_id);
        `);

        // Sticker cache - device-wide (no owner_zalo_id)
        this.exec(`
            CREATE TABLE IF NOT EXISTS stickers (
                sticker_id INTEGER PRIMARY KEY,
                cat_id INTEGER DEFAULT 0,
                type INTEGER DEFAULT 0,
                text TEXT DEFAULT '',
                sticker_url TEXT DEFAULT '',
                sticker_sprite_url TEXT DEFAULT '',
                checksum TEXT DEFAULT '',
                data_json TEXT DEFAULT '{}',
                unsupported INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS sticker_packs (
                cat_id INTEGER PRIMARY KEY,
                name TEXT DEFAULT '',
                thumb_url TEXT DEFAULT '',
                sticker_count INTEGER DEFAULT 0,
                data_json TEXT DEFAULT '{}',
                updated_at INTEGER DEFAULT 0
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS recent_stickers (
                sticker_id INTEGER PRIMARY KEY,
                used_at INTEGER NOT NULL
            );
        `);

        // Keyword → sticker IDs cache
        this.exec(`
            CREATE TABLE IF NOT EXISTS keyword_stickers (
                keyword TEXT PRIMARY KEY,
                sticker_ids TEXT DEFAULT '[]',
                updated_at INTEGER DEFAULT 0
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS pinned_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                msg_type TEXT NOT NULL DEFAULT 'text',
                content TEXT NOT NULL DEFAULT '',
                preview_text TEXT DEFAULT '',
                preview_image TEXT DEFAULT '',
                sender_id TEXT DEFAULT '',
                sender_name TEXT DEFAULT '',
                timestamp INTEGER NOT NULL DEFAULT 0,
                pinned_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, thread_id, msg_id)
            );
            CREATE INDEX IF NOT EXISTS idx_pinned ON pinned_messages(owner_zalo_id, thread_id, pinned_at DESC);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS friend_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                direction TEXT NOT NULL DEFAULT 'received',
                msg TEXT DEFAULT '',
                created_at INTEGER DEFAULT 0,
                updated_at INTEGER DEFAULT 0,
                UNIQUE(owner_zalo_id, user_id, direction)
            );
            CREATE INDEX IF NOT EXISTS idx_friend_requests_owner ON friend_requests(owner_zalo_id, direction);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS local_quick_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                keyword TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                media_json TEXT DEFAULT NULL,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, keyword)
            );
            CREATE INDEX IF NOT EXISTS idx_lqm_owner ON local_quick_messages(owner_zalo_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS local_pinned_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                pinned_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, thread_id)
            );
            CREATE INDEX IF NOT EXISTS idx_lpc_owner ON local_pinned_conversations(owner_zalo_id, pinned_at DESC);
        `);

        // "Tin đánh dấu" (starred messages, local to the app, every channel)
        this.exec(`
            CREATE TABLE IF NOT EXISTS starred_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                starred_at INTEGER NOT NULL DEFAULT 0,
                snapshot TEXT DEFAULT NULL,
                UNIQUE(owner_zalo_id, thread_id, msg_id)
            );
            CREATE INDEX IF NOT EXISTS idx_starred_owner ON starred_messages(owner_zalo_id, starred_at DESC);
        `);

        // ─── CRM tables ──────────────────────────────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#3B82F6',
                emoji TEXT NOT NULL DEFAULT '🏷️',
                created_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_crm_tags_owner ON crm_tags(owner_zalo_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_contact_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                tag_id INTEGER NOT NULL,
                UNIQUE(owner_zalo_id, contact_id, tag_id),
                FOREIGN KEY(tag_id) REFERENCES crm_tags(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_crm_ct_owner ON crm_contact_tags(owner_zalo_id, contact_id);
            CREATE INDEX IF NOT EXISTS idx_crm_ct_tag ON crm_contact_tags(tag_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                contact_type TEXT NOT NULL DEFAULT 'user',
                content TEXT NOT NULL DEFAULT '',
                topic_id TEXT DEFAULT NULL,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_crm_notes ON crm_notes(owner_zalo_id, contact_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                channel TEXT NOT NULL DEFAULT 'zalo',
                name TEXT NOT NULL,
                template_message TEXT NOT NULL DEFAULT '',
                friend_request_message TEXT NOT NULL DEFAULT '',
                campaign_type TEXT NOT NULL DEFAULT 'message',
                mixed_config TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'draft',
                delay_seconds INTEGER NOT NULL DEFAULT 60,
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_crm_campaigns ON crm_campaigns(owner_zalo_id, status);
        `);
        // Migration: add new columns if they don't exist yet (existing DBs)
        try { this.exec(`ALTER TABLE crm_campaigns ADD COLUMN friend_request_message TEXT NOT NULL DEFAULT ''`); } catch {}
        try { this.exec(`ALTER TABLE crm_campaigns ADD COLUMN campaign_type TEXT NOT NULL DEFAULT 'message'`); } catch {}
        try { this.exec(`ALTER TABLE crm_campaigns ADD COLUMN mixed_config TEXT NOT NULL DEFAULT '{}'`); } catch {}
        try { this.exec(`ALTER TABLE crm_campaigns ADD COLUMN channel TEXT NOT NULL DEFAULT 'zalo'`); } catch {}

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_campaign_contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL,
                owner_zalo_id TEXT NOT NULL,
                contact_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                avatar TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                sent_at INTEGER DEFAULT 0,
                retry_count INTEGER DEFAULT 0,
                error TEXT DEFAULT '',
                UNIQUE(campaign_id, contact_id),
                FOREIGN KEY(campaign_id) REFERENCES crm_campaigns(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_crm_cc_campaign ON crm_campaign_contacts(campaign_id, status);
            CREATE INDEX IF NOT EXISTS idx_crm_cc_owner ON crm_campaign_contacts(owner_zalo_id, status);
        `);
        // Migration phải chạy SAU khi bảng đã tồn tại (DB mới sẽ throw nếu ALTER trước CREATE)
        try { this.exec(`ALTER TABLE crm_campaign_contacts ADD COLUMN phone TEXT NOT NULL DEFAULT ''`); } catch {}

        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_send_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                channel TEXT NOT NULL DEFAULT 'zalo',
                contact_id TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                contact_type TEXT DEFAULT 'user',
                campaign_id INTEGER DEFAULT NULL,
                message TEXT NOT NULL DEFAULT '',
                sent_at INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'sent',
                error TEXT DEFAULT '',
                data_request TEXT DEFAULT '',
                data_response TEXT DEFAULT '',
                send_type TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_crm_log_owner ON crm_send_log(owner_zalo_id, sent_at DESC);
            CREATE INDEX IF NOT EXISTS idx_crm_log_contact ON crm_send_log(owner_zalo_id, contact_id);
        `);
        try { this.exec(`ALTER TABLE crm_send_log ADD COLUMN channel TEXT NOT NULL DEFAULT 'zalo'`); } catch {}

        // ─── Local Labels (custom per-app labels, independent from Zalo) ────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS local_labels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#3B82F6',
                text_color TEXT NOT NULL DEFAULT '#FFFFFF',
                emoji TEXT NOT NULL DEFAULT '🏷️',
                page_ids TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_local_labels_name ON local_labels(name);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS local_label_threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                label_id INTEGER NOT NULL,
                thread_id TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT 0,
                UNIQUE(owner_zalo_id, label_id, thread_id),
                FOREIGN KEY(label_id) REFERENCES local_labels(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_llt_owner ON local_label_threads(owner_zalo_id, label_id);
            CREATE INDEX IF NOT EXISTS idx_llt_thread ON local_label_threads(owner_zalo_id, thread_id);
        `);

        // ─── Workflow Engine Tables ────────────────────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS workflows (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                description  TEXT DEFAULT '',
                enabled      INTEGER DEFAULT 1,
                channel      TEXT NOT NULL DEFAULT 'zalo',
                page_id      TEXT DEFAULT '',
                page_ids     TEXT DEFAULT '',
                nodes_json   TEXT NOT NULL DEFAULT '[]',
                edges_json   TEXT NOT NULL DEFAULT '[]',
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS workflow_run_logs (
                id              TEXT PRIMARY KEY,
                workflow_id     TEXT NOT NULL,
                workflow_name   TEXT NOT NULL,
                triggered_by    TEXT NOT NULL,
                started_at      INTEGER NOT NULL,
                finished_at     INTEGER NOT NULL,
                status          TEXT NOT NULL,
                error_message   TEXT,
                node_results    TEXT NOT NULL DEFAULT '[]'
            );
            CREATE INDEX IF NOT EXISTS idx_wf_logs_workflow ON workflow_run_logs(workflow_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_wf_logs_status ON workflow_run_logs(status, started_at DESC);
        `);

        // Migration: add page_ids column to workflows if missing + backfill from page_id
        try {
            const wfCols = this.query<any>(`PRAGMA table_info(workflows)`);
            if (!wfCols.some((c: any) => c.name === 'page_ids')) {
                db!.exec(`ALTER TABLE workflows ADD COLUMN page_ids TEXT DEFAULT ''`);
                // Backfill: migrate existing page_id → page_ids
                db!.exec(`UPDATE workflows SET page_ids = page_id WHERE page_id != '' AND (page_ids IS NULL OR page_ids = '')`);
                this.save();
                Logger.log('[DatabaseService] Migration: added page_ids column to workflows');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] workflows page_ids migration: ${err.message}`);
        }

        // ─── Integration Hub Table ─────────────────────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS integrations (
                id                    TEXT PRIMARY KEY,
                type                  TEXT NOT NULL,
                name                  TEXT NOT NULL DEFAULT '',
                enabled               INTEGER NOT NULL DEFAULT 1,
                credentials_encrypted TEXT NOT NULL DEFAULT '{}',
                settings              TEXT NOT NULL DEFAULT '{}',
                connected_at          INTEGER,
                created_at            INTEGER NOT NULL,
                updated_at            INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_integrations_type ON integrations(type, enabled);
        `);

        // ─── AI Assistants ────────────────────���───────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS ai_assistants (
                id                    TEXT PRIMARY KEY,
                name                  TEXT NOT NULL,
                platform              TEXT NOT NULL DEFAULT 'openai',
                api_key_encrypted     TEXT NOT NULL DEFAULT '',
                model                 TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
                system_prompt         TEXT NOT NULL DEFAULT '',
                pos_integration_id    TEXT DEFAULT NULL,
                pinned_products_json  TEXT NOT NULL DEFAULT '[]',
                max_tokens            INTEGER NOT NULL DEFAULT 1000,
                temperature           REAL NOT NULL DEFAULT 0.7,
                context_message_count INTEGER NOT NULL DEFAULT 30,
                enabled               INTEGER NOT NULL DEFAULT 1,
                is_default            INTEGER NOT NULL DEFAULT 0,
                created_at            INTEGER NOT NULL,
                updated_at            INTEGER NOT NULL
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS ai_assistant_files (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                assistant_id    TEXT NOT NULL,
                file_name       TEXT NOT NULL,
                file_path       TEXT NOT NULL DEFAULT '',
                file_size       INTEGER NOT NULL DEFAULT 0,
                content_text    TEXT NOT NULL DEFAULT '',
                created_at      INTEGER NOT NULL,
                FOREIGN KEY(assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_ai_files_assistant ON ai_assistant_files(assistant_id);
        `);

        // ─── AI Conversations (chat history per thread + assistant) ───────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS ai_conversations (
                id              TEXT PRIMARY KEY,
                zalo_id         TEXT NOT NULL,
                thread_id       TEXT NOT NULL,
                assistant_id    TEXT NOT NULL,
                title           TEXT DEFAULT '',
                last_message_at INTEGER NOT NULL,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ai_conv_thread ON ai_conversations(zalo_id, thread_id);
            CREATE INDEX IF NOT EXISTS idx_ai_conv_assistant ON ai_conversations(assistant_id);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS ai_conversation_messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role            TEXT NOT NULL,
                content         TEXT NOT NULL,
                segments_json   TEXT DEFAULT NULL,
                created_at      INTEGER NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_ai_msg_conv ON ai_conversation_messages(conversation_id);
        `);

        // ─── Facebook Integration Tables ──────────────────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS fb_accounts (
                id                  TEXT PRIMARY KEY,
                facebook_id         TEXT,
                name                TEXT DEFAULT '',
                avatar_url          TEXT DEFAULT '',
                cookie_encrypted    TEXT NOT NULL DEFAULT '',
                session_data        TEXT DEFAULT '',
                status              TEXT DEFAULT 'disconnected',
                last_cookie_check   INTEGER DEFAULT 0,
                created_at          INTEGER NOT NULL,
                updated_at          INTEGER NOT NULL
            );
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS fb_threads (
                id                      TEXT PRIMARY KEY,
                account_id              TEXT NOT NULL,
                name                    TEXT DEFAULT '',
                type                    TEXT DEFAULT 'group',
                emoji                   TEXT,
                participant_count       INTEGER DEFAULT 0,
                last_message_preview    TEXT,
                last_message_at         INTEGER,
                unread_count            INTEGER DEFAULT 0,
                is_muted                INTEGER DEFAULT 0,
                is_e2ee                 INTEGER DEFAULT 0,
                metadata                TEXT,
                synced_at               INTEGER,
                FOREIGN KEY (account_id) REFERENCES fb_accounts(id)
            );
            CREATE INDEX IF NOT EXISTS idx_fb_threads_account ON fb_threads(account_id, last_message_at DESC);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS fb_messages (
                id              TEXT PRIMARY KEY,
                account_id      TEXT NOT NULL,
                thread_id       TEXT NOT NULL,
                sender_id       TEXT DEFAULT '',
                sender_name     TEXT DEFAULT '',
                body            TEXT,
                timestamp       INTEGER NOT NULL,
                type            TEXT DEFAULT 'text',
                attachments     TEXT DEFAULT '[]',
                reply_to_id     TEXT,
                is_self         INTEGER DEFAULT 0,
                is_unsent       INTEGER DEFAULT 0,
                reactions       TEXT DEFAULT '{}',
                created_at      INTEGER NOT NULL,
                FOREIGN KEY (account_id) REFERENCES fb_accounts(id)
            );
            CREATE INDEX IF NOT EXISTS idx_fb_messages_thread ON fb_messages(account_id, thread_id, timestamp DESC);
        `);

        this.exec(`
            CREATE TABLE IF NOT EXISTS fb_crm_contacts (
                id                  TEXT PRIMARY KEY,
                fb_account_id       TEXT NOT NULL,
                facebook_user_id    TEXT NOT NULL,
                facebook_thread_id  TEXT,
                display_name        TEXT DEFAULT '',
                avatar_url          TEXT DEFAULT '',
                tag_ids             TEXT DEFAULT '[]',
                notes               TEXT DEFAULT '[]',
                custom_fields       TEXT DEFAULT '{}',
                created_at          INTEGER NOT NULL,
                updated_at          INTEGER NOT NULL,
                UNIQUE(fb_account_id, facebook_user_id),
                FOREIGN KEY (fb_account_id) REFERENCES fb_accounts(id)
            );
            CREATE INDEX IF NOT EXISTS idx_fb_crm_account ON fb_crm_contacts(fb_account_id);
        `);

        // ─── Proxies ─────────────────────────────────────────────────────────────
        this.exec(`
            CREATE TABLE IF NOT EXISTS proxies (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL DEFAULT '',
                type        TEXT NOT NULL DEFAULT 'http',
                host        TEXT NOT NULL DEFAULT '',
                port        INTEGER NOT NULL DEFAULT 0,
                username    TEXT DEFAULT '',
                password    TEXT DEFAULT '',
                created_at  INTEGER NOT NULL DEFAULT 0,
                updated_at  INTEGER NOT NULL DEFAULT 0
            );
        `);

    }

    // ─── ERP Schema ────────────────────────────────────────────────────────────

    /**
     * Khởi tạo schema cho ERP module. Idempotent - safe to call on every startup.
     * Tất cả bảng đều prefix erp_.
     */
    public initErpSchema(): void {
        try {
            // ── Projects ──────────────────────────────────────────────────────
            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    color TEXT DEFAULT '#3b82f6',
                    owner_employee_id TEXT DEFAULT '',
                    department_id INTEGER,
                    status TEXT DEFAULT 'active',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_projects_status ON erp_projects(status);
            `);

            // ── Tasks ─────────────────────────────────────────────────────────
            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_tasks (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    parent_task_id TEXT,
                    title TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    status TEXT DEFAULT 'todo',
                    priority TEXT DEFAULT 'normal',
                    reporter_id TEXT DEFAULT '',
                    start_date INTEGER,
                    due_date INTEGER,
                    completed_at INTEGER,
                    estimated_hours REAL,
                    actual_hours REAL DEFAULT 0,
                    recurring_rule TEXT,
                    linked_contact_id TEXT,
                    linked_zalo_msg_id TEXT,
                    sort_order INTEGER DEFAULT 0,
                    archived INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_tasks_project ON erp_tasks(project_id);
                CREATE INDEX IF NOT EXISTS idx_erp_tasks_status ON erp_tasks(status);
                CREATE INDEX IF NOT EXISTS idx_erp_tasks_due ON erp_tasks(due_date);
                CREATE INDEX IF NOT EXISTS idx_erp_tasks_parent ON erp_tasks(parent_task_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_task_assignees (
                    task_id TEXT NOT NULL,
                    employee_id TEXT NOT NULL,
                    assigned_at INTEGER NOT NULL,
                    PRIMARY KEY (task_id, employee_id)
                );
                CREATE INDEX IF NOT EXISTS idx_erp_assignees_emp ON erp_task_assignees(employee_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_task_checklist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    done INTEGER DEFAULT 0,
                    sort_order INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_checklist_task ON erp_task_checklist(task_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_task_comments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL,
                    author_id TEXT NOT NULL,
                    content TEXT NOT NULL DEFAULT '',
                    mentions TEXT DEFAULT '[]',
                    parent_comment_id INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_comments_task ON erp_task_comments(task_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_task_attachments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL,
                    file_name TEXT NOT NULL DEFAULT '',
                    file_path TEXT NOT NULL DEFAULT '',
                    mime_type TEXT DEFAULT '',
                    size INTEGER DEFAULT 0,
                    uploaded_by TEXT DEFAULT '',
                    uploaded_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_attach_task ON erp_task_attachments(task_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_task_activity_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL,
                    actor_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    payload TEXT DEFAULT '{}',
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_activity_task ON erp_task_activity_log(task_id);
            `);

            // ── Calendar ──────────────────────────────────────────────────────
            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_calendar_events (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    type TEXT DEFAULT 'meeting',
                    start_at INTEGER NOT NULL,
                    end_at INTEGER NOT NULL,
                    all_day INTEGER DEFAULT 0,
                    location TEXT DEFAULT '',
                    color TEXT DEFAULT '',
                    organizer_id TEXT DEFAULT '',
                    linked_task_id TEXT,
                    linked_contact_id TEXT,
                    recurring_rule TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_events_start ON erp_calendar_events(start_at);
                CREATE INDEX IF NOT EXISTS idx_erp_events_organizer ON erp_calendar_events(organizer_id);
            `);
            // Lịch tạo từ tin nhắn: tài khoản + tin gốc → nhắc lịch mở đúng hội thoại, nhảy tới tin
            for (const column of ['linked_account_id', 'linked_msg_id']) {
                try { this.exec(`ALTER TABLE erp_calendar_events ADD COLUMN ${column} TEXT`); } catch { /* đã có */ }
            }

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_event_reminders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL,
                    minutes_before INTEGER NOT NULL,
                    channel TEXT DEFAULT 'toast',
                    triggered INTEGER DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_erp_reminders_event ON erp_event_reminders(event_id);
            `);

            // ── Notes ─────────────────────────────────────────────────────────
            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_note_folders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    parent_id INTEGER,
                    owner_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_note_folders_owner ON erp_note_folders(owner_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_notes (
                    id TEXT PRIMARY KEY,
                    folder_id INTEGER,
                    title TEXT NOT NULL DEFAULT 'Untitled',
                    content TEXT DEFAULT '',
                    author_id TEXT NOT NULL,
                    pinned INTEGER DEFAULT 0,
                    share_scope TEXT DEFAULT 'private',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_notes_folder ON erp_notes(folder_id);
                CREATE INDEX IF NOT EXISTS idx_erp_notes_author ON erp_notes(author_id);
                CREATE INDEX IF NOT EXISTS idx_erp_notes_updated ON erp_notes(updated_at);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_note_tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    color TEXT DEFAULT '#6b7280'
                );
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_note_tag_map (
                    note_id TEXT NOT NULL,
                    tag_id INTEGER NOT NULL,
                    PRIMARY KEY (note_id, tag_id)
                );
                CREATE INDEX IF NOT EXISTS idx_erp_note_tag_map_tag ON erp_note_tag_map(tag_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_note_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    note_id TEXT NOT NULL,
                    content_snapshot TEXT NOT NULL DEFAULT '',
                    editor_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_note_versions_note ON erp_note_versions(note_id);
            `);

            // ── Collab extras (Phase 2) ───────────────────────────────────────
            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_task_watchers (
                    task_id TEXT NOT NULL,
                    employee_id TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (task_id, employee_id)
                );
                CREATE INDEX IF NOT EXISTS idx_erp_watchers_emp ON erp_task_watchers(employee_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_task_dependencies (
                    task_id TEXT NOT NULL,
                    depends_on_task_id TEXT NOT NULL,
                    type TEXT DEFAULT 'FS',
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY (task_id, depends_on_task_id)
                );
                CREATE INDEX IF NOT EXISTS idx_erp_deps_dep ON erp_task_dependencies(depends_on_task_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_event_attendees (
                    event_id TEXT NOT NULL,
                    employee_id TEXT NOT NULL,
                    status TEXT DEFAULT 'invited',
                    PRIMARY KEY (event_id, employee_id)
                );
                CREATE INDEX IF NOT EXISTS idx_erp_event_attendees_emp ON erp_event_attendees(employee_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_note_shares (
                    note_id TEXT NOT NULL,
                    employee_id TEXT NOT NULL,
                    permission TEXT DEFAULT 'read',
                    PRIMARY KEY (note_id, employee_id)
                );
                CREATE INDEX IF NOT EXISTS idx_erp_note_shares_emp ON erp_note_shares(employee_id);
            `);

            // ── HRM (Phase 2) ─────────────────────────────────────────────────
            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_departments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    parent_id INTEGER,
                    manager_employee_id TEXT DEFAULT '',
                    description TEXT DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_dept_parent ON erp_departments(parent_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_positions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    level INTEGER DEFAULT 0,
                    department_id INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_positions_dept ON erp_positions(department_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_employee_profiles (
                    employee_id TEXT PRIMARY KEY,
                    department_id INTEGER,
                    position_id INTEGER,
                    manager_employee_id TEXT DEFAULT '',
                    dob INTEGER,
                    gender TEXT DEFAULT '',
                    phone TEXT DEFAULT '',
                    email TEXT DEFAULT '',
                    address TEXT DEFAULT '',
                    joined_at INTEGER,
                    erp_role TEXT DEFAULT 'member',
                    extra_json TEXT DEFAULT '{}',
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_profiles_dept ON erp_employee_profiles(department_id);
                CREATE INDEX IF NOT EXISTS idx_erp_profiles_manager ON erp_employee_profiles(manager_employee_id);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    check_in_at INTEGER,
                    check_out_at INTEGER,
                    note TEXT DEFAULT '',
                    source TEXT DEFAULT 'manual',
                    updated_at INTEGER NOT NULL,
                    UNIQUE(employee_id, date)
                );
                CREATE INDEX IF NOT EXISTS idx_erp_attendance_emp_date ON erp_attendance(employee_id, date);
            `);

            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_leave_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    requester_id TEXT NOT NULL,
                    leave_type TEXT DEFAULT 'annual',
                    start_date TEXT NOT NULL,
                    end_date TEXT NOT NULL,
                    days REAL DEFAULT 1,
                    reason TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    approver_id TEXT DEFAULT '',
                    decided_at INTEGER,
                    decision_note TEXT DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_leave_status ON erp_leave_requests(status);
                CREATE INDEX IF NOT EXISTS idx_erp_leave_requester ON erp_leave_requests(requester_id);
                CREATE INDEX IF NOT EXISTS idx_erp_leave_approver ON erp_leave_requests(approver_id);
            `);

            // ── Notifications ─────────────────────────────────────────────────
            this.exec(`
                CREATE TABLE IF NOT EXISTS erp_notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    recipient_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    body TEXT DEFAULT '',
                    link TEXT DEFAULT '',
                    payload TEXT DEFAULT '{}',
                    read INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_erp_notify_recipient ON erp_notifications(recipient_id, read);
                CREATE INDEX IF NOT EXISTS idx_erp_notify_created ON erp_notifications(created_at);
            `);

            Logger.log('[DatabaseService] ERP schema initialized');
        } catch (err: any) {
            Logger.error(`[DatabaseService] initErpSchema error: ${err.message}`);
        }
    }

    /** Dọn dẹp dữ liệu cũ bị lỗi từ các phiên bản trước */
    private migrate(): void {
        try {
            // Add quote_data column if it doesn't exist
            const cols = this.query<any>(`PRAGMA table_info(messages)`);
            const hasQuoteData = cols.some((c) => c.name === 'quote_data');
            if (!hasQuoteData) {
                db!.exec(`ALTER TABLE messages ADD COLUMN quote_data TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added quote_data column');
            }

            const hasReactions = cols.some((c) => c.name === 'reactions');
            if (!hasReactions) {
                db!.exec(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'`);
                this.save();
                Logger.log('[DatabaseService] Migration: added reactions column');
            }

            const hasIsRecalled = cols.some((c: any) => c.name === 'is_recalled');
            if (!hasIsRecalled) {
                db!.exec(`ALTER TABLE messages ADD COLUMN is_recalled INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added is_recalled column');
            }

            const hasRecalledContent = cols.some((c: any) => c.name === 'recalled_content');
            if (!hasRecalledContent) {
                db!.exec(`ALTER TABLE messages ADD COLUMN recalled_content TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added recalled_content column');
            }

            const hasRecalledMsgType = cols.some((c: any) => c.name === 'recalled_msg_type');
            if (!hasRecalledMsgType) {
                db!.exec(`ALTER TABLE messages ADD COLUMN recalled_msg_type TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added recalled_msg_type column');
            }

            const hasDeletedBy = cols.some((c: any) => c.name === 'deleted_by');
            if (!hasDeletedBy) {
                db!.exec(`ALTER TABLE messages ADD COLUMN deleted_by TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added deleted_by column');
            }

            const hasReplyToId = cols.some((c: any) => c.name === 'reply_to_id');
            if (!hasReplyToId) {
                db!.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added reply_to_id column');
            }

            const hasEditHistory = cols.some((c: any) => c.name === 'edit_history');
            if (!hasEditHistory) {
                db!.exec(`ALTER TABLE messages ADD COLUMN edit_history TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added edit_history column');
            }

            const hasIsEdited = cols.some((c: any) => c.name === 'is_edited');
            if (!hasIsEdited) {
                db!.exec(`ALTER TABLE messages ADD COLUMN is_edited INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added is_edited column');
            }

            // Zalo gắn thời gian tự xoá cho tin (ms, ZL-05): chỉ để hiện đồng hồ — Deplao không xoá tin theo TTL
            const hasTtl = cols.some((c: any) => c.name === 'ttl');
            if (!hasTtl) {
                db!.exec(`ALTER TABLE messages ADD COLUMN ttl INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added ttl column');
            }

            // Add listener_active column to accounts if missing
            const accCols = this.query<any>(`PRAGMA table_info(accounts)`);
            const hasListenerActive = accCols.some((c: any) => c.name === 'listener_active');
            if (!hasListenerActive) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN listener_active INTEGER DEFAULT 1`);
                this.save();
                Logger.log('[DatabaseService] Migration: added listener_active column');
            }

            // This is a legacy clean-up. It used to scan the complete messages
            // table every launch just to confirm there was nothing to delete.
            // At millions of messages that blocks application startup, so run
            // it once and record the completed data migration in app_settings.
            const invalidRowsMigrationKey = 'migration_invalid_contact_thread_cleanup_v1';
            const invalidRowsMigrationDone = this.queryOne<{ value: string }>(
                'SELECT value FROM app_settings WHERE key = ?',
                [invalidRowsMigrationKey],
            )?.value === 'done';
            if (!invalidRowsMigrationDone) {
                // Releases prior to this version already ran the clean-up on
                // each launch. Re-running a table scan now is disproportionate
                // on large databases, so record it as retired. New writes are
                // validated before persistence and cannot recreate these rows.
                this.run(
                    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'done', datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
                    [invalidRowsMigrationKey],
                );
                Logger.log('[DatabaseService] Legacy invalid-row scan retired');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration warning: ${err.message}`);
        }

        // ─── Migration: add `channel` column for multi-channel support ────────────
        try {
            const contactCols = this.query<any>(`PRAGMA table_info(contacts)`);
            const hasChannel = contactCols.some((c: any) => c.name === 'channel');
            if (!hasChannel) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db!.exec(`ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db!.exec(`ALTER TABLE accounts ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                this.save();
                Logger.log('[DatabaseService] ✅ Migration: added channel column to contacts, messages, accounts');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration channel column: ${err.message}`);
        }

        // Zalo occasionally sends a recall/undo command through the ordinary
        // message stream. Older versions persisted that control JSON as a chat
        // bubble. Convert only the unambiguous control shape to a recall and
        // remove the synthetic bubble; real JSON messages do not have all four
        // of globalMsgId, cliMsgId, deleteMsg and srcId.
        try {
            // Another historical one-off migration. The four unindexed LIKE
            // predicates force a full content scan on every launch otherwise.
            const undoCleanupMigrationKey = 'migration_zalo_undo_cleanup_v1';
            const undoCleanupMigrationDone = this.queryOne<{ value: string }>(
                'SELECT value FROM app_settings WHERE key = ?',
                [undoCleanupMigrationKey],
            )?.value === 'done';
            if (!undoCleanupMigrationDone) {
                // The old conversion was also run by earlier releases. Mark it
                // retired instead of scanning every message body at startup.
                this.run(
                    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'done', datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
                    [undoCleanupMigrationKey],
                );
                Logger.log('[DatabaseService] Legacy Zalo undo scan retired');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration undo control cleanup: ${err.message}`);
        }

        // ─── Migration: copy fb_* data → unified tables (Phase B3) ─────────────
        try {
            const hasFbTable = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='fb_accounts'`);
            if (hasFbTable.length > 0) {
                const fbInAccounts = this.query<any>(`SELECT COUNT(*) as n FROM accounts WHERE channel = 'facebook'`);
                if ((fbInAccounts[0]?.n || 0) === 0) {
                    const fbAccCount = this.query<any>(`SELECT COUNT(*) as n FROM fb_accounts`);
                    if ((fbAccCount[0]?.n || 0) > 0) {
                        Logger.log('[DatabaseService] 🔄 Migration B3: copying fb_* data → unified tables...');
                        db!.exec(`
                            INSERT OR IGNORE INTO accounts (zalo_id, full_name, avatar_url, imei, user_agent, cookies, is_active, created_at, channel)
                            SELECT COALESCE(facebook_id, id), COALESCE(name, ''), COALESCE(avatar_url, ''), '', '', COALESCE(cookie_encrypted, ''), 1, datetime(created_at/1000, 'unixepoch'), 'facebook'
                            FROM fb_accounts
                        `);
                        db!.exec(`
                            INSERT OR IGNORE INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
                            SELECT COALESCE(f.facebook_id, ft.account_id), ft.id, COALESCE(ft.name, ''), '', 0,
                                   CASE WHEN ft.type = 'user' THEN 'user' ELSE 'group' END,
                                   COALESCE(ft.unread_count, 0), COALESCE(ft.last_message_preview, ''), COALESCE(ft.last_message_at, 0), 'facebook'
                            FROM fb_threads ft
                            LEFT JOIN fb_accounts f ON f.id = ft.account_id
                        `);
                        db!.exec(`
                            INSERT OR IGNORE INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel)
                            SELECT fm.id, COALESCE(f.facebook_id, fm.account_id), fm.thread_id, 0, COALESCE(fm.sender_id, ''),
                                   COALESCE(fm.body, ''), COALESCE(fm.type, 'text'), fm.timestamp, COALESCE(fm.is_self, 0),
                                   COALESCE(fm.attachments, '[]'), 'received', 'facebook'
                            FROM fb_messages fm
                            LEFT JOIN fb_accounts f ON f.id = fm.account_id
                        `);
                        this.save();
                        Logger.log('[DatabaseService] ✅ Migration B3: fb_* data copied to unified tables');
                    }
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration fb→unified: ${err.message}`);
        }

        // ─── Migration: channel indexes ────────────────────────────────────────
        try {
            db!.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_channel ON contacts(channel, owner_zalo_id)`);
            db!.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, owner_zalo_id, thread_id)`);
            // These indexes serve the two high-volume paths: cursor based chat
            // pagination and reports scoped to an account/date range.  Without
            // them SQLite scans/sorts a growing share of the whole messages table.
            db!.exec(`CREATE INDEX IF NOT EXISTS idx_messages_owner_timestamp ON messages(owner_zalo_id, timestamp)`);
            db!.exec(`CREATE INDEX IF NOT EXISTS idx_messages_owner_type_timestamp ON messages(owner_zalo_id, thread_type, timestamp)`);
            db!.exec(`CREATE INDEX IF NOT EXISTS idx_messages_thread_cursor ON messages(owner_zalo_id, thread_id, timestamp DESC, msg_id DESC)`);
            db!.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_others ON contacts(owner_zalo_id, is_in_others)`);
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration channel indexes: ${err.message}`);
        }

        // ─── Migration: add channel to workflows + backfill legacy rows ───────
        try {
            const workflowCols = this.query<any>(`PRAGMA table_info(workflows)`);
            if (workflowCols.length > 0 && !workflowCols.some((c: any) => c.name === 'channel')) {
                db!.exec(`ALTER TABLE workflows ADD COLUMN channel TEXT NOT NULL DEFAULT 'zalo'`);
                Logger.log('[DatabaseService] Migration: added channel column to workflows');
            }
            db!.exec(`UPDATE workflows SET channel = 'zalo' WHERE channel IS NULL OR TRIM(channel) = ''`);
            this.save();
        } catch (err: any) {
            Logger.warn(`[DatabaseService] workflow channel migration warning: ${err.message}`);
        }

        // ─── Migration B4: FB accounts.zalo_id UUID → facebook_id ─────────────
        // Previously FB accounts stored internal UUID as zalo_id; now we use the real Facebook UID
        try {
            const fbWithUuid = this.query<any>(
                `SELECT a.zalo_id, f.facebook_id FROM accounts a
                 JOIN fb_accounts f ON a.zalo_id = f.id
                 WHERE a.channel = 'facebook' AND f.facebook_id IS NOT NULL AND f.facebook_id != ''`
            );
            for (const row of fbWithUuid) {
                if (row.zalo_id !== row.facebook_id) {
                    // Check if facebook_id already exists in accounts to avoid unique constraint violation
                    const existing = this.queryOne<any>(`SELECT 1 FROM accounts WHERE zalo_id = ?`, [row.facebook_id]);
                    if (!existing) {
                        db!.exec(`UPDATE accounts SET zalo_id = '${row.facebook_id}' WHERE zalo_id = '${row.zalo_id}' AND channel = 'facebook'`);
                        Logger.log(`[DatabaseService] ✅ Migration B4: FB account ${row.zalo_id} → ${row.facebook_id}`);
                    } else {
                        // Already migrated or duplicate - remove the old UUID row
                        db!.exec(`DELETE FROM accounts WHERE zalo_id = '${row.zalo_id}' AND channel = 'facebook'`);
                        Logger.log(`[DatabaseService] ✅ Migration B4: Removed duplicate FB account row ${row.zalo_id}`);
                    }
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration B4 fb zalo_id→facebook_id: ${err.message}`);
        }

        // ─── Migration: add channel to CRM tables ──────────────────────────────
        // ─── Migration B5: fix contacts & messages owner_zalo_id UUID → facebook_id ──
        // Migration B3 incorrectly used account_id (UUID) as owner_zalo_id.
        // This rewrites them to the real facebook_id so UI queries match.
        try {
            const migrateFacebookOwner = (fromOwnerId: string, toOwnerId: string) => {
                // A target owner can already contain the same contact/message.
                // Preserve both rows when that happens: the target is already
                // usable and automatic deduplication could discard user data.
                const contactsFixed = db!.prepare(
                    `UPDATE OR IGNORE contacts
                     SET owner_zalo_id = ?
                     WHERE owner_zalo_id = ? AND channel = 'facebook'`,
                ).run(toOwnerId, fromOwnerId);
                const messagesFixed = db!.prepare(
                    `UPDATE OR IGNORE messages
                     SET owner_zalo_id = ?
                     WHERE owner_zalo_id = ? AND channel = 'facebook'`,
                ).run(toOwnerId, fromOwnerId);
                return {
                    contactsFixed: Number(contactsFixed.changes || 0),
                    messagesFixed: Number(messagesFixed.changes || 0),
                };
            };

            const fbAccs = this.query<any>(
                `SELECT id, facebook_id FROM fb_accounts WHERE facebook_id IS NOT NULL AND facebook_id != ''`
            );
            for (const acc of fbAccs) {
                if (acc.id === acc.facebook_id) continue; // already correct
                const migrated = migrateFacebookOwner(acc.id, acc.facebook_id);
                if (migrated.contactsFixed > 0 || migrated.messagesFixed > 0) {
                    Logger.log(`[DatabaseService] ✅ Migration B5: Rewrote owner_zalo_id ${acc.id} → ${acc.facebook_id} (contacts: ${migrated.contactsFixed}, messages: ${migrated.messagesFixed})`);
                }
            }
            // Also fix any stale UUIDs from previously deleted accounts
            // Find contacts/messages with UUID owner_zalo_id that match no current fb_accounts
            const staleContacts = this.query<any>(
                `SELECT DISTINCT c.owner_zalo_id FROM contacts c
                 WHERE c.channel = 'facebook'
                 AND c.owner_zalo_id NOT GLOB '[0-9]*'
                 AND NOT EXISTS (SELECT 1 FROM fb_accounts f WHERE f.id = c.owner_zalo_id)`
            );
            for (const sc of staleContacts) {
                // Try to find fb_account by matching thread data
                const sample = this.queryOne<any>(
                    `SELECT t.account_id FROM fb_threads t
                     JOIN contacts c ON c.contact_id = t.id
                     WHERE c.owner_zalo_id = ? LIMIT 1`, [sc.owner_zalo_id]
                );
                if (sample?.account_id) {
                    const fbAcc = this.queryOne<any>(`SELECT facebook_id FROM fb_accounts WHERE id = ?`, [sample.account_id]);
                    if (fbAcc?.facebook_id) {
                        migrateFacebookOwner(sc.owner_zalo_id, fbAcc.facebook_id);
                        Logger.log(`[DatabaseService] ✅ Migration B5: Fixed stale UUID ${sc.owner_zalo_id} → ${fbAcc.facebook_id}`);
                    }
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration B5 fix owner_zalo_id: ${err.message}`);
        }

        try {
            const crmTagCols = this.query<any>(`PRAGMA table_info(crm_tags)`);
            if (crmTagCols.length > 0 && !crmTagCols.some((c: any) => c.name === 'channel')) {
                db!.exec(`ALTER TABLE crm_tags ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db!.exec(`ALTER TABLE crm_contact_tags ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db!.exec(`ALTER TABLE crm_notes ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                this.save();
                Logger.log('[DatabaseService] ��� Migration: added channel to CRM tables');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration CRM channel: ${err.message}`);
        }

        // ─── Migration: add proxy_id to accounts ──────────────────────────────────
        try {
            const accCols2 = this.query<any>(`PRAGMA table_info(accounts)`);
            if (!accCols2.some((c: any) => c.name === 'proxy_id')) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN proxy_id INTEGER DEFAULT NULL`);
                Logger.log('[DatabaseService] ✅ Migration: added proxy_id column to accounts');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Migration proxy_id: ${err.message}`);
        }

        // Migration: create friends table if missing
        try {
            const tables = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='friends'`);
            if (tables.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS friends (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        display_name TEXT DEFAULT '',
                        avatar TEXT DEFAULT '',
                        phone TEXT DEFAULT '',
                        updated_at INTEGER DEFAULT 0,
                        UNIQUE(owner_zalo_id, user_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_friends_owner ON friends(owner_zalo_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created friends table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Friends table migration warning: ${err.message}`);
        }

        // Migration: create page_group_member table if missing
        try {
            const gmt = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='page_group_member'`);
            if (gmt.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS page_group_member (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        group_id TEXT NOT NULL,
                        member_id TEXT NOT NULL,
                        display_name TEXT DEFAULT '',
                        avatar TEXT DEFAULT '',
                        role INTEGER DEFAULT 0,
                        updated_at INTEGER DEFAULT 0,
                        UNIQUE(owner_zalo_id, group_id, member_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_group_member ON page_group_member(owner_zalo_id, group_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created page_group_member table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] page_group_member migration warning: ${err.message}`);
        }

        // Migration: add username column to page_group_member if missing
        try {
            const cols = this.query<any>(`PRAGMA table_info(page_group_member)`);
            if (cols.length > 0 && !cols.some((c: any) => c.name === 'username')) {
                db!.exec(`ALTER TABLE page_group_member ADD COLUMN username TEXT DEFAULT ''`);
                this.save();
                Logger.log('[DatabaseService] Migration: added username column to page_group_member');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] page_group_member username migration warning: ${err.message}`);
        }

        // Migration: create friend_requests table if missing
        try {
            const frt = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='friend_requests'`);
            if (frt.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS friend_requests (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        display_name TEXT DEFAULT '',
                        avatar TEXT DEFAULT '',
                        phone TEXT DEFAULT '',
                        direction TEXT NOT NULL DEFAULT 'received',
                        msg TEXT DEFAULT '',
                        created_at INTEGER DEFAULT 0,
                        updated_at INTEGER DEFAULT 0,
                        UNIQUE(owner_zalo_id, user_id, direction)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_friend_requests_owner ON friend_requests(owner_zalo_id, direction)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created friend_requests table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] friend_requests migration warning: ${err.message}`);
        }
        try {
            const st = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='stickers'`);
            if (st.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS stickers (
                        sticker_id INTEGER PRIMARY KEY,
                        cat_id INTEGER DEFAULT 0,
                        type INTEGER DEFAULT 0,
                        text TEXT DEFAULT '',
                        sticker_url TEXT DEFAULT '',
                        sticker_sprite_url TEXT DEFAULT '',
                        checksum TEXT DEFAULT '',
                        data_json TEXT DEFAULT '{}',
                        updated_at INTEGER DEFAULT 0
                    )
                `);
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS recent_stickers (
                        sticker_id INTEGER PRIMARY KEY,
                        used_at INTEGER NOT NULL
                    )
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created stickers/recent_stickers tables');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] stickers migration warning: ${err.message}`);
        }

        // Migration: add unsupported column to stickers + sticker_packs table
        try {
            const cols = this.query<any>(`PRAGMA table_info(stickers)`);
            if (cols.length > 0 && !cols.find((c: any) => c.name === 'unsupported')) {
                db!.exec(`ALTER TABLE stickers ADD COLUMN unsupported INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added unsupported column to stickers');
            }
            const sp = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='sticker_packs'`);
            if (sp.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS sticker_packs (
                        cat_id INTEGER PRIMARY KEY,
                        name TEXT DEFAULT '',
                        thumb_url TEXT DEFAULT '',
                        sticker_count INTEGER DEFAULT 0,
                        data_json TEXT DEFAULT '{}',
                        updated_at INTEGER DEFAULT 0
                    )
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created sticker_packs table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] sticker_packs migration warning: ${err.message}`);
        }

        // Migration: create keyword_stickers table if missing
        try {
            const ks = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='keyword_stickers'`);
            if (ks.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS keyword_stickers (
                        keyword TEXT PRIMARY KEY,
                        sticker_ids TEXT DEFAULT '[]',
                        updated_at INTEGER DEFAULT 0
                    )
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created keyword_stickers table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] keyword_stickers migration warning: ${err.message}`);
        }

        // Migration: create pinned_messages table if missing
        try {
            const pm = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='pinned_messages'`);
            if (pm.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS pinned_messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        msg_id TEXT NOT NULL,
                        msg_type TEXT NOT NULL DEFAULT 'text',
                        content TEXT NOT NULL DEFAULT '',
                        preview_text TEXT DEFAULT '',
                        preview_image TEXT DEFAULT '',
                        sender_id TEXT DEFAULT '',
                        sender_name TEXT DEFAULT '',
                        timestamp INTEGER NOT NULL DEFAULT 0,
                        pinned_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, thread_id, msg_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_pinned ON pinned_messages(owner_zalo_id, thread_id, pinned_at)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created pinned_messages table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] pinned_messages migration warning: ${err.message}`);
        }

        // Migration: create local_quick_messages table if missing
        try {
            const lqm = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='local_quick_messages'`);
            if (lqm.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS local_quick_messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        keyword TEXT NOT NULL,
                        title TEXT NOT NULL DEFAULT '',
                        media_json TEXT DEFAULT NULL,
                        created_at INTEGER NOT NULL DEFAULT 0,
                        updated_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, keyword)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_lqm_owner ON local_quick_messages(owner_zalo_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created local_quick_messages table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_quick_messages migration warning: ${err.message}`);
        }
        // Migration: add phone column to accounts if missing
        try {
            const cols = this.query<any>(`PRAGMA table_info(accounts)`);
            if (!cols.some((c: any) => c.name === 'phone')) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN phone TEXT DEFAULT ''`);
                this.save();
                Logger.log('[DatabaseService] Migration: added phone column to accounts');
            }
            if (!cols.some((c: any) => c.name === 'is_business')) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN is_business INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added is_business column to accounts');
            }
            if (!cols.some((c: any) => c.name === 'username')) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN username TEXT DEFAULT ''`);
                this.save();
                Logger.log('[DatabaseService] Migration: added username column to accounts');
            }
            // Zalo "My Documents": hội thoại riêng có sẵn của Zalo (loginInfo.send2me_id), KHÔNG phải hội thoại với chính mình
            if (!cols.some((c: any) => c.name === 'send2me_id')) {
                db!.exec(`ALTER TABLE accounts ADD COLUMN send2me_id TEXT DEFAULT ''`);
                this.save();
                Logger.log('[DatabaseService] Migration: added send2me_id column to accounts');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] accounts migration warning: ${err.message}`);
        }

        // Migration: add alias column to contacts if missing
        try {
            const contactCols = this.query<any>(`PRAGMA table_info(contacts)`);
            const names = contactCols.map((c: any) => c.name);
            let needSave = false;
            if (!names.includes('is_muted')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN is_muted INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added is_muted to contacts');
                needSave = true;
            }
            if (!names.includes('mute_until')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN mute_until INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added mute_until to contacts');
                needSave = true;
            }
            if (!names.includes('is_in_others')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN is_in_others INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added is_in_others to contacts');
                needSave = true;
            }
            // Zalo: tự xoá tin nhắn (ms, ZL-05 — Deplao chỉ hiển thị, không xoá tin) và hội thoại ẩn bằng PIN (ZL-03)
            if (!names.includes('zalo_auto_delete_ttl')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN zalo_auto_delete_ttl INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added zalo_auto_delete_ttl to contacts');
                needSave = true;
            }
            if (!names.includes('zalo_hidden')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN zalo_hidden INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added zalo_hidden to contacts');
                needSave = true;
            }
            if (!names.includes('has_mention')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN has_mention INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added has_mention to contacts');
                needSave = true;
            }
            // Mốc người kia đã nhận / đã xem tin mình gửi (services/receipts/peerReceipts.ts): ms; Telegram theo id tin.
            // reply_marked_at: đánh dấu đã trả lời tay / hàng loạt (shared/chat/replyState) — mốc tin mới nhất lúc đánh dấu, ms
            for (const column of ['peer_delivered_ts', 'peer_read_ts', 'peer_read_max_id', 'reply_marked_at']) {
                if (!names.includes(column)) {
                    db!.exec(`ALTER TABLE contacts ADD COLUMN ${column} INTEGER DEFAULT 0`);
                    Logger.log(`[DatabaseService] Migration: added ${column} to contacts`);
                    needSave = true;
                }
            }
            if (!names.includes('alias')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN alias TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added alias to contacts');
                needSave = true;
            }
            if (!names.includes('gender')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN gender INTEGER DEFAULT NULL`);
                Logger.log('[DatabaseService] Migration: added gender to contacts');
                needSave = true;
            }
            if (!names.includes('birthday')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN birthday TEXT DEFAULT NULL`);
                Logger.log('[DatabaseService] Migration: added birthday to contacts');
                needSave = true;
            }
            // Lần cuối tên/avatar được làm mới hàng loạt từ API (unix ms). 0/NULL = chưa bao giờ.
            if (!names.includes('info_refreshed_at')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN info_refreshed_at INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added info_refreshed_at to contacts');
                needSave = true;
            }
            const telegramColumns: Array<[string, string]> = [
                ['telegram_folder_id', 'INTEGER DEFAULT 0'],
                ['telegram_archived', 'INTEGER DEFAULT 0'],
                ['telegram_can_send', 'INTEGER DEFAULT NULL'],
                ['telegram_send_reason', "TEXT DEFAULT ''"],
                ['telegram_peer_type', "TEXT DEFAULT ''"],
                ['telegram_members_count', 'INTEGER DEFAULT 0'],
                ['telegram_online_count', 'INTEGER DEFAULT 0'],
                ['telegram_state_updated_at', 'INTEGER DEFAULT 0'],
                ['telegram_membership_state', "TEXT DEFAULT 'member'"],
                ['telegram_join_action', "TEXT DEFAULT 'none'"],
                ['is_cov_bot', 'INTEGER DEFAULT NULL'],
                ['menu_button', "TEXT DEFAULT NULL"],
                ['has_main_app', 'INTEGER DEFAULT 0'],
            ];
            for (const [column, definition] of telegramColumns) {
                if (!names.includes(column)) {
                    db!.exec(`ALTER TABLE contacts ADD COLUMN ${column} ${definition}`);
                    Logger.log(`[DatabaseService] Migration: added ${column} to contacts`);
                    needSave = true;
                }
            }
            if (needSave) this.save();
            // Reset is_cov_bot=0 and has_main_app=0 to NULL so existing contacts get re-checked
            try { db!.exec(`UPDATE contacts SET is_cov_bot = NULL WHERE is_cov_bot = 0 AND channel = 'telegram_user'`); } catch {}
            try { db!.exec(`UPDATE contacts SET has_main_app = NULL WHERE has_main_app = 0 AND channel = 'telegram_user'`); } catch {}
        } catch (err: any) {
            Logger.warn(`[DatabaseService] contacts flags migration warning: ${err.message}`);
        }

        // Migration: add display_name and phone to crm_send_log if missing
        try {
            const logCols = this.query<any>(`PRAGMA table_info(crm_send_log)`);
            const logColNames = logCols.map((c: any) => c.name);
            let needSave = false;
            if (!logColNames.includes('display_name')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN display_name TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added display_name to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('phone')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN phone TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added phone to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('contact_type')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN contact_type TEXT DEFAULT 'user'`);
                Logger.log('[DatabaseService] Migration: added contact_type to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('data_request')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN data_request TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added data_request to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('data_response')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN data_response TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added data_response to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('send_type')) {
                db!.exec(`ALTER TABLE crm_send_log ADD COLUMN send_type TEXT DEFAULT ''`);
                Logger.log('[DatabaseService] Migration: added send_type to crm_send_log');
                needSave = true;
            }
            if (needSave) this.save();
        } catch (err: any) {
            Logger.warn(`[DatabaseService] crm_send_log migration warning: ${err.message}`);
        }

        // Migration: add text_color to local_labels if missing
        try {
            const llCols = this.query<any>(`PRAGMA table_info(local_labels)`);
            if (llCols.length > 0 && !llCols.some((c: any) => c.name === 'text_color')) {
                db!.exec(`ALTER TABLE local_labels ADD COLUMN text_color TEXT NOT NULL DEFAULT '#FFFFFF'`);
                this.save();
                Logger.log('[DatabaseService] Migration: added text_color to local_labels');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_labels text_color migration: ${err.message}`);
        }

        // Migration: add is_active + sort_order to local_quick_messages
        try {
            const lqmCols = this.query<any>(`PRAGMA table_info(local_quick_messages)`);
            if (lqmCols.length > 0) {
                const lqmNames = lqmCols.map((c: any) => c.name);
                if (!lqmNames.includes('is_active')) {
                    db!.exec(`ALTER TABLE local_quick_messages ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
                    Logger.log('[DatabaseService] Migration: added is_active to local_quick_messages');
                }
                if (!lqmNames.includes('sort_order')) {
                    db!.exec(`ALTER TABLE local_quick_messages ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
                    Logger.log('[DatabaseService] Migration: added sort_order to local_quick_messages');
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_quick_messages is_active/sort_order migration: ${err.message}`);
        }

        // Migration: add is_active + sort_order + shortcut to local_labels
        try {
            const llCols2 = this.query<any>(`PRAGMA table_info(local_labels)`);
            if (llCols2.length > 0) {
                const llNames2 = llCols2.map((c: any) => c.name);
                if (!llNames2.includes('is_active')) {
                    db!.exec(`ALTER TABLE local_labels ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
                    Logger.log('[DatabaseService] Migration: added is_active to local_labels');
                }
                if (!llNames2.includes('sort_order')) {
                    db!.exec(`ALTER TABLE local_labels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
                    Logger.log('[DatabaseService] Migration: added sort_order to local_labels');
                }
                if (!llNames2.includes('shortcut')) {
                    db!.exec(`ALTER TABLE local_labels ADD COLUMN shortcut TEXT NOT NULL DEFAULT ''`);
                    Logger.log('[DatabaseService] Migration: added shortcut to local_labels');
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_labels is_active/sort_order/shortcut migration: ${err.message}`);
        }

        // Migration: add context_message_count to ai_assistants if missing
        try {
            const aiCols = this.query<any>(`PRAGMA table_info(ai_assistants)`);
            if (aiCols.length > 0 && !aiCols.some((c: any) => c.name === 'context_message_count')) {
                db!.exec(`ALTER TABLE ai_assistants ADD COLUMN context_message_count INTEGER NOT NULL DEFAULT 30`);
                this.save();
                Logger.log('[DatabaseService] Migration: added context_message_count to ai_assistants');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] ai_assistants context_message_count migration: ${err.message}`);
        }

        // Migration: add pinned_products_json to ai_assistants if missing
        try {
            const aiCols2 = this.query<any>(`PRAGMA table_info(ai_assistants)`);
            if (aiCols2.length > 0 && !aiCols2.some((c: any) => c.name === 'pinned_products_json')) {
                db!.exec(`ALTER TABLE ai_assistants ADD COLUMN pinned_products_json TEXT NOT NULL DEFAULT '[]'`);
                this.save();
                Logger.log('[DatabaseService] Migration: added pinned_products_json to ai_assistants');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] pinned_products_json migration: ${err.message}`);
        }

        // Migration: create ai_account_assistants table for per-account assistant assignment
        try {
            const aat = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='ai_account_assistants'`);
            if (aat.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS ai_account_assistants (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        zalo_id TEXT NOT NULL,
                        role TEXT NOT NULL CHECK(role IN ('suggestion', 'panel')),
                        assistant_id TEXT NOT NULL,
                        UNIQUE(zalo_id, role),
                        FOREIGN KEY(assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_ai_account_role ON ai_account_assistants(zalo_id, role)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created ai_account_assistants table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] ai_account_assistants migration: ${err.message}`);
        }

        // Migration: create ai_usage_logs table for tracking AI usage
        try {
            const aul = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='ai_usage_logs'`);
            if (aul.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS ai_usage_logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        assistant_id TEXT NOT NULL,
                        assistant_name TEXT DEFAULT '',
                        platform TEXT DEFAULT '',
                        model TEXT DEFAULT '',
                        prompt_text TEXT DEFAULT '',
                        response_text TEXT DEFAULT '',
                        prompt_tokens INTEGER DEFAULT 0,
                        completion_tokens INTEGER DEFAULT 0,
                        total_tokens INTEGER DEFAULT 0,
                        created_at INTEGER NOT NULL DEFAULT 0
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage_logs(created_at)`);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_assistant ON ai_usage_logs(assistant_id, created_at)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created ai_usage_logs table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] ai_usage_logs migration: ${err.message}`);
        }

        // Migration: create message_drafts table if missing
        try {
            const md = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='message_drafts'`);
            if (md.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS message_drafts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        content TEXT NOT NULL DEFAULT '',
                        updated_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, thread_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_drafts_owner ON message_drafts(owner_zalo_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created message_drafts table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] message_drafts migration: ${err.message}`);
        }

        // Migration: create bank_cards table if missing
        try {
            const bc = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='bank_cards'`);
            if (bc.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS bank_cards (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        bank_name TEXT NOT NULL DEFAULT '',
                        bin_bank INTEGER NOT NULL DEFAULT 0,
                        account_number TEXT NOT NULL DEFAULT '',
                        account_name TEXT NOT NULL DEFAULT '',
                        is_default INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL DEFAULT 0,
                        updated_at INTEGER NOT NULL DEFAULT 0
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_bank_cards_owner ON bank_cards(owner_zalo_id)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created bank_cards table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] bank_cards migration: ${err.message}`);
        }

        // Migration: create local_pinned_conversations table if missing
        try {
            const lpc = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='local_pinned_conversations'`);
            if (lpc.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS local_pinned_conversations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        pinned_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, thread_id)
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_lpc_owner ON local_pinned_conversations(owner_zalo_id, pinned_at DESC)`);
                this.save();
                Logger.log('[DatabaseService] Migration: created local_pinned_conversations table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] local_pinned_conversations migration: ${err.message}`);
        }

        // Migration: create starred_messages table if missing ("Tin đánh dấu")
        try {
            const starred = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='starred_messages'`);
            if (starred.length === 0) {
                db!.exec(`
            CREATE TABLE IF NOT EXISTS starred_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                starred_at INTEGER NOT NULL DEFAULT 0,
                snapshot TEXT DEFAULT NULL,
                UNIQUE(owner_zalo_id, thread_id, msg_id)
            );
            CREATE INDEX IF NOT EXISTS idx_starred_owner ON starred_messages(owner_zalo_id, starred_at DESC);
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created starred_messages table');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] starred_messages migration: ${err.message}`);
        }

        // Migration: add topic_id and contact_type to crm_notes if missing
        try {
            const noteCols = this.query<any>(`PRAGMA table_info(crm_notes)`);
            if (noteCols.length > 0) {
                const noteColNames = noteCols.map((c: any) => c.name);
                let needSave = false;
                if (!noteColNames.includes('topic_id')) {
                    db!.exec(`ALTER TABLE crm_notes ADD COLUMN topic_id TEXT DEFAULT NULL`);
                    Logger.log('[DatabaseService] Migration: added topic_id to crm_notes');
                    needSave = true;
                }
                if (!noteColNames.includes('contact_type')) {
                    db!.exec(`ALTER TABLE crm_notes ADD COLUMN contact_type TEXT NOT NULL DEFAULT 'user'`);
                    Logger.log('[DatabaseService] Migration: added contact_type to crm_notes');
                    needSave = true;
                }
                if (needSave) this.save();
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] crm_notes migration: ${err.message}`);
        }

        // Migration: create employee management tables
        try {
            const empT = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='employees'`);
            if (empT.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS employees (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        employee_id TEXT NOT NULL UNIQUE,
                        username TEXT NOT NULL UNIQUE,
                        password_hash TEXT NOT NULL,
                        display_name TEXT NOT NULL,
                        avatar_url TEXT DEFAULT '',
                        role TEXT NOT NULL DEFAULT 'employee',
                        is_active INTEGER NOT NULL DEFAULT 1,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        last_login INTEGER DEFAULT NULL
                    )
                `);
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS employee_permissions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        employee_id TEXT NOT NULL,
                        module TEXT NOT NULL,
                        can_access INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(employee_id, module),
                        FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
                    )
                `);
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS employee_account_access (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        employee_id TEXT NOT NULL,
                        zalo_id TEXT NOT NULL,
                        UNIQUE(employee_id, zalo_id),
                        FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
                    )
                `);
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS employee_message_log (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        employee_id TEXT NOT NULL,
                        zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        thread_type INTEGER NOT NULL DEFAULT 0,
                        msg_id TEXT,
                        action TEXT NOT NULL,
                        metadata TEXT DEFAULT '{}',
                        timestamp INTEGER NOT NULL
                    )
                `);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_emp_msg_log_employee ON employee_message_log(employee_id)`);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_emp_msg_log_zalo ON employee_message_log(zalo_id)`);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_emp_msg_log_ts ON employee_message_log(timestamp)`);
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS employee_sessions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        employee_id TEXT NOT NULL,
                        machine_name TEXT DEFAULT '',
                        ip_address TEXT DEFAULT '',
                        connected_at INTEGER NOT NULL,
                        disconnected_at INTEGER DEFAULT NULL,
                        FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
                    )
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created employee management tables (employees, employee_permissions, employee_account_access, employee_message_log, employee_sessions)');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] employee tables migration: ${err.message}`);
        }

        // Migration: create employee_groups table + add group_id to employees
        try {
            const grpT = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='employee_groups'`);
            if (grpT.length === 0) {
                db!.exec(`
                    CREATE TABLE IF NOT EXISTS employee_groups (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        group_id TEXT NOT NULL UNIQUE,
                        name TEXT NOT NULL,
                        color TEXT DEFAULT '',
                        sort_order INTEGER DEFAULT 0,
                        created_at INTEGER NOT NULL
                    )
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: created employee_groups table');
            }
            // Add group_id column to employees if missing
            const empCols = this.query<any>(`PRAGMA table_info(employees)`);
            if (empCols.length > 0 && !empCols.some((c: any) => c.name === 'group_id')) {
                db!.exec(`ALTER TABLE employees ADD COLUMN group_id TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added group_id to employees');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] employee_groups migration: ${err.message}`);
        }

        // Migration: add handled_by_employee column to messages if missing
        try {
            const msgCols = this.query<any>(`PRAGMA table_info(messages)`);
            if (msgCols.length > 0 && !msgCols.some((c: any) => c.name === 'handled_by_employee')) {
                db!.exec(`ALTER TABLE messages ADD COLUMN handled_by_employee TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added handled_by_employee to messages');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] handled_by_employee migration: ${err.message}`);
        }

        // Migration: add daily_send_limit + daily_start_time to crm_campaigns
        try {
            const campCols = this.query<any>(`PRAGMA table_info(crm_campaigns)`);
            if (campCols.length > 0 && !campCols.some((c: any) => c.name === 'daily_send_limit')) {
                db!.exec(`ALTER TABLE crm_campaigns ADD COLUMN daily_send_limit INTEGER NOT NULL DEFAULT 0`);
                db!.exec(`ALTER TABLE crm_campaigns ADD COLUMN daily_start_time TEXT NOT NULL DEFAULT '08:00'`);
                this.save();
                Logger.log('[DatabaseService] Migration: added daily_send_limit + daily_start_time to crm_campaigns');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] daily_send_limit migration: ${err.message}`);
        }

        // Migration: add delay_min_seconds + delay_max_seconds + per_contact_delay to crm_campaigns
        try {
            const campCols2 = this.query<any>(`PRAGMA table_info(crm_campaigns)`);
            if (campCols2.length > 0 && !campCols2.some((c: any) => c.name === 'delay_min_seconds')) {
                db!.exec(`ALTER TABLE crm_campaigns ADD COLUMN delay_min_seconds INTEGER NOT NULL DEFAULT 60`);
                db!.exec(`ALTER TABLE crm_campaigns ADD COLUMN delay_max_seconds INTEGER NOT NULL DEFAULT 60`);
                db!.exec(`ALTER TABLE crm_campaigns ADD COLUMN per_contact_delay_min_seconds INTEGER NOT NULL DEFAULT 0`);
                db!.exec(`ALTER TABLE crm_campaigns ADD COLUMN per_contact_delay_max_seconds INTEGER NOT NULL DEFAULT 0`);
                // Backfill existing campaigns: derive range from delay_seconds (±10s, min 30s)
                db!.exec(`UPDATE crm_campaigns SET delay_min_seconds = MAX(30, delay_seconds - 10), delay_max_seconds = delay_seconds + 10 WHERE delay_min_seconds = 60 AND delay_max_seconds = 60`);
                this.save();
                Logger.log('[DatabaseService] Migration: added delay_min/max + per_contact_delay to crm_campaigns');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] delay_min/max migration: ${err.message}`);
        }

        // ── fb_threads.is_e2ee ──────────────────────────────────────────────
        try {
            const threadCols = this.query<any>(`PRAGMA table_info(fb_threads)`);
            if (!threadCols.some((c: any) => c.name === 'is_e2ee')) {
                db!.exec(`ALTER TABLE fb_threads ADD COLUMN is_e2ee INTEGER DEFAULT 0`);
                this.save();
                Logger.log('[DatabaseService] Migration: added is_e2ee to fb_threads');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] is_e2ee migration: ${err.message}`);
        }

        // ── fb_messages.edit_history ────────────────────────────────────────
        try {
            const fbMsgCols = this.query<any>(`PRAGMA table_info(fb_messages)`);
            if (!fbMsgCols.some((c: any) => c.name === 'edit_history')) {
                db!.exec(`ALTER TABLE fb_messages ADD COLUMN edit_history TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added edit_history to fb_messages');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] edit_history migration: ${err.message}`);
        }

        // ── ai_assistants.base_url ────────────────────────────────────────────
        try {
            const aiCols = this.query<any>(`PRAGMA table_info(ai_assistants)`);
            if (aiCols.length > 0 && !aiCols.some((c: any) => c.name === 'base_url')) {
                db!.exec(`ALTER TABLE ai_assistants ADD COLUMN base_url TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added base_url to ai_assistants');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] base_url migration: ${err.message}`);
        }

        // ── contacts.is_forum (Telegram forum detection cache) ──────────────
        try {
            const contactCols = this.query<any>(`PRAGMA table_info(contacts)`);
            if (!contactCols.some((c: any) => c.name === 'is_forum')) {
                db!.exec(`ALTER TABLE contacts ADD COLUMN is_forum INTEGER DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added is_forum column to contacts');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] is_forum migration: ${err.message}`);
        }

        // ── messages.inline_buttons (Telegram inline keyboard) ────────────────
        try {
            const msgCols = this.query<any>(`PRAGMA table_info(messages)`);
            if (!msgCols.some((c: any) => c.name === 'inline_buttons')) {
                db!.exec(`ALTER TABLE messages ADD COLUMN inline_buttons TEXT DEFAULT NULL`);
                this.save();
                Logger.log('[DatabaseService] Migration: added inline_buttons column to messages');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] inline_buttons migration: ${err.message}`);
        }

        // Telegram message IDs are only unique inside a chat. The original
        // (msg_id, owner_zalo_id) key silently dropped messages from a second
        // Telegram group/channel that reused the same numeric message ID.
        // Rebuild once with a channel + thread scoped uniqueness constraint.
        try {
            const indexes = this.query<any>(`PRAGMA index_list(messages)`);
            const hasScopedMessageKey = indexes.some((index: any) => {
                if (!Number(index?.unique)) return false;
                const name = String(index?.name || '').replace(/"/g, '""');
                const columns = this.query<any>(`PRAGMA index_info("${name}")`)
                    .sort((a: any, b: any) => Number(a.seqno) - Number(b.seqno))
                    .map((column: any) => column.name);
                return columns.join('|') === 'msg_id|owner_zalo_id|channel|thread_id';
            });

            if (!hasScopedMessageKey) {
                db!.exec(`
                    BEGIN TRANSACTION;
                    ALTER TABLE messages RENAME TO messages_legacy_unique;
                    CREATE TABLE messages (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        msg_id TEXT NOT NULL,
                        cli_msg_id TEXT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        thread_type INTEGER NOT NULL DEFAULT 0,
                        sender_id TEXT NOT NULL,
                        content TEXT NOT NULL DEFAULT '',
                        msg_type TEXT NOT NULL DEFAULT 'text',
                        timestamp INTEGER NOT NULL,
                        is_sent INTEGER DEFAULT 0,
                        attachments TEXT DEFAULT '[]',
                        local_paths TEXT DEFAULT '{}',
                        status TEXT DEFAULT 'received',
                        is_recalled INTEGER DEFAULT 0,
                        quote_data TEXT DEFAULT NULL,
                        reactions TEXT DEFAULT '{}',
                        recalled_content TEXT DEFAULT NULL,
                        recalled_msg_type TEXT DEFAULT NULL,
                        deleted_by TEXT DEFAULT NULL,
                        reply_to_id TEXT DEFAULT NULL,
                        edit_history TEXT DEFAULT NULL,
                        is_edited INTEGER DEFAULT 0,
                        channel TEXT DEFAULT 'zalo',
                        topic_id TEXT DEFAULT NULL,
                        handled_by_employee TEXT DEFAULT NULL,
                        UNIQUE(msg_id, owner_zalo_id, channel, thread_id)
                    );
                    INSERT OR IGNORE INTO messages (
                        id, msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type,
                        sender_id, content, msg_type, timestamp, is_sent, attachments,
                        local_paths, status, is_recalled, quote_data, reactions,
                        recalled_content, recalled_msg_type, deleted_by, reply_to_id, edit_history, is_edited,
                        channel, topic_id, handled_by_employee
                    )
                    SELECT
                        id, msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type,
                        sender_id, content, msg_type, timestamp, is_sent, attachments,
                        local_paths, status, is_recalled, quote_data, reactions,
                        recalled_content, NULL, deleted_by, reply_to_id, edit_history, is_edited,
                        COALESCE(channel, 'zalo'), NULL, handled_by_employee
                    FROM messages_legacy_unique;
                    DROP TABLE messages_legacy_unique;
                    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(owner_zalo_id, thread_id, timestamp);
                    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, owner_zalo_id, thread_id);
                    COMMIT;
                `);
                this.save();
                Logger.log('[DatabaseService] Migration: scoped message uniqueness by channel and thread');
            }
        } catch (err: any) {
            try { db!.exec('ROLLBACK'); } catch {}
            Logger.warn(`[DatabaseService] scoped message uniqueness migration: ${err.message}`);
        }

        // Telegram forum messages share one chat ID. Keep their root-message
        // identity in the unified message table so history can be queried
        // without mixing unrelated topics.
        try {
            const messageCols = this.query<any>(`PRAGMA table_info(messages)`);
            if (messageCols.length > 0 && !messageCols.some((column: any) => column.name === 'topic_id')) {
                db!.exec(`ALTER TABLE messages ADD COLUMN topic_id TEXT DEFAULT NULL`);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(owner_zalo_id, thread_id, topic_id, timestamp)`);
                this.save();
                Logger.log('[DatabaseService] Migration: added messages.topic_id for Telegram forum history');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] messages.topic_id migration: ${err.message}`);
        }
        // DB tạo từ 26.8.0 có cột topic_id ngay trong CREATE TABLE nên nhánh trên không chạy → chưa từng có chỉ mục topic
        // (mở một topic forum quét cả lịch sử nhóm). Bản một phần: chỉ tin có topic, xây nhanh, tin thường không tốn ghi
        // thêm. DB cũ đã có bản đầy đủ cùng tên thì giữ nguyên — getMessages theo topic dùng được cả hai.
        try {
            db!.exec(`CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(owner_zalo_id, thread_id, topic_id, timestamp) WHERE topic_id IS NOT NULL`);
        } catch (err: any) {
            Logger.warn(`[DatabaseService] idx_messages_topic: ${err.message}`);
        }

        try {
            this.ensurePlainIdMapTable();
        } catch (err: any) {
            Logger.warn(`[DatabaseService] zalo_plain_id_map migration: ${err.message}`);
        }

        // Media Zalo hết hạn (CDN không còn file) → UI hiện "Ảnh/Video đã hết hạn", không thử tải lại.
        try {
            const messageCols = this.query<any>(`PRAGMA table_info(messages)`);
            if (messageCols.length > 0 && !messageCols.some((column: any) => column.name === 'media_expired')) {
                db!.exec(`ALTER TABLE messages ADD COLUMN media_expired INTEGER DEFAULT 0`);
                Logger.log('[DatabaseService] Migration: added messages.media_expired');
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] messages.media_expired migration: ${err.message}`);
        }
    }

    /**
     * Đồng bộ từ điện thoại: cache ánh xạ ID mobile (plain, 9-10 số) → ID web (noise) theo từng
     * tài khoản (ID noise khác nhau giữa các tài khoản xem) — lấy từ API znoise.
     * Gọi lại ở accessor vì DB phụ (runOnBossDb/withDbPath) không chạy migrate().
     */
    private ensurePlainIdMapTable(): void {
        db!.exec(`
            CREATE TABLE IF NOT EXISTS zalo_plain_id_map (
                owner_zalo_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                plain_id TEXT NOT NULL,
                noise_id TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (owner_zalo_id, kind, plain_id)
            )
        `);
    }

    // ─── Account Operations ───────────────────────────────────────────────

    // ─── Forum Detection Cache ─────────────────────────────────────────────

    /** Lấy is_forum từ contacts table. null = chưa check, 0 = not forum, 1 = forum */
    public getIsForum(ownerZaloId: string, contactId: string): number | null {
        if (!this.initialized) return null;
        const row = this.queryOne<any>(
            `SELECT is_forum FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?`,
            [ownerZaloId, contactId]
        );
        return row?.is_forum ?? null;
    }

    /** Lưu is_forum vào contacts table */
    public setIsForum(ownerZaloId: string, contactId: string, isForum: boolean): void {
        if (!this.initialized) return;
        this.run(
            `UPDATE contacts SET is_forum = ? WHERE owner_zalo_id = ? AND contact_id = ?`,
            [isForum ? 1 : 0, ownerZaloId, contactId]
        );
    }

    // ─── Telegram MTProto Peer Cache ──────────────────────────────────────

    public upsertTelegramPeer(ownerZaloId: string, peer: Omit<TelegramPeer, 'accountId'>): void {
        if (!this.initialized || !peer.peerId) return;
        this.run(`
            INSERT INTO telegram_peers
                (owner_zalo_id, peer_id, peer_type, access_hash, username, display_name, phone, avatar_url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_zalo_id, peer_id) DO UPDATE SET
                peer_type = excluded.peer_type,
                access_hash = CASE WHEN excluded.access_hash != '' THEN excluded.access_hash ELSE telegram_peers.access_hash END,
                username = CASE WHEN excluded.username != '' THEN excluded.username ELSE telegram_peers.username END,
                display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE telegram_peers.display_name END,
                phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE telegram_peers.phone END,
                avatar_url = CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE telegram_peers.avatar_url END,
                updated_at = excluded.updated_at
        `, [
            ownerZaloId,
            peer.peerId,
            peer.peerType || 'user',
            peer.accessHash || '',
            peer.username || '',
            peer.displayName || '',
            peer.phone || '',
            peer.avatarUrl || '',
            Date.now(),
        ]);
    }

    public getTelegramPeer(ownerZaloId: string, peerId: string): any | null {
        if (!this.initialized || !peerId) return null;
        return this.queryOne<any>(
            `SELECT * FROM telegram_peers WHERE owner_zalo_id = ? AND peer_id = ?`,
            [ownerZaloId, peerId]
        );
    }

    /** Quản trị viên đã lưu của nhóm Telegram (role 1 = người tạo, 2 = quản trị viên; rank = chức vụ tự đặt). */
    public getTelegramGroupAdmins(ownerZaloId: string, groupId: string): Array<{ member_id: string; role: number; rank: string; updated_at: number }> {
        if (!this.initialized || !groupId) return [];
        return this.query(
            `SELECT member_id, role, rank, updated_at FROM telegram_group_admins WHERE owner_zalo_id = ? AND group_id = ?`,
            [ownerZaloId, groupId]
        );
    }

    /** Thay danh sách quản trị viên của nhóm (người bị gỡ quyền không còn nhãn). */
    public replaceTelegramGroupAdmins(ownerZaloId: string, groupId: string, admins: Array<{ memberId: string; role: number; rank: string }>): void {
        if (!this.initialized || !groupId) return;
        const now = Date.now();
        db!.transaction(() => {
            db!.prepare(`DELETE FROM telegram_group_admins WHERE owner_zalo_id = ? AND group_id = ?`).run(ownerZaloId, groupId);
            const insert = db!.prepare(
                `INSERT OR REPLACE INTO telegram_group_admins (owner_zalo_id, group_id, member_id, role, rank, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            for (const admin of admins) {
                if (admin.memberId) insert.run(ownerZaloId, groupId, admin.memberId, admin.role || 2, admin.rank || '', now);
            }
        })();
    }

    public getTelegramUpdateState(ownerZaloId: string): { pts: number; qts: number; date: number; seq: number; updated_at: number } | null {
        if (!this.initialized || !ownerZaloId) return null;
        return this.queryOne<any>(
            `SELECT pts, qts, date, seq, updated_at FROM telegram_update_state WHERE owner_zalo_id = ?`,
            [ownerZaloId]
        );
    }

    public saveTelegramUpdateState(ownerZaloId: string, state: { pts: number; qts: number; date: number; seq: number }): void {
        if (!this.initialized || !ownerZaloId) return;
        this.run(`
            INSERT INTO telegram_update_state (owner_zalo_id, pts, qts, date, seq, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_zalo_id) DO UPDATE SET
                pts = excluded.pts,
                qts = excluded.qts,
                date = excluded.date,
                seq = excluded.seq,
                updated_at = excluded.updated_at
        `, [
            ownerZaloId,
            Number(state.pts || 0),
            Number(state.qts || 0),
            Number(state.date || 0),
            Number(state.seq || 0),
            Date.now(),
        ]);
    }

    // ─── Telegram per-channel pts ──────────────────────────────────────────

    public getTelegramChannelPts(ownerZaloId: string, channelId: string): number {
        if (!this.initialized || !ownerZaloId || !channelId) return 0;
        const row = this.queryOne<any>(
            `SELECT pts FROM telegram_channel_pts WHERE owner_zalo_id = ? AND channel_id = ?`,
            [ownerZaloId, channelId]
        );
        return row?.pts ?? 0;
    }

    public saveTelegramChannelPts(ownerZaloId: string, channelId: string, pts: number): void {
        if (!this.initialized || !ownerZaloId || !channelId) return;
        this.run(`
            INSERT INTO telegram_channel_pts (owner_zalo_id, channel_id, pts, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(owner_zalo_id, channel_id) DO UPDATE SET
                -- A socket update and getChannelDifference can finish in a
                -- different order. PTS is monotonic, so accepting a stale
                -- lower value would reopen an already-consumed interval.
                pts = CASE WHEN excluded.pts > telegram_channel_pts.pts THEN excluded.pts ELSE telegram_channel_pts.pts END,
                updated_at = CASE WHEN excluded.pts > telegram_channel_pts.pts THEN excluded.updated_at ELSE telegram_channel_pts.updated_at END
        `, [ownerZaloId, channelId, Number(pts || 0), Date.now()]);
    }

    public getAllTelegramChannelPts(ownerZaloId: string): Array<{ channel_id: string; pts: number }> {
        if (!this.initialized || !ownerZaloId) return [];
        return this.query<any>(
            `SELECT channel_id, pts FROM telegram_channel_pts WHERE owner_zalo_id = ?`,
            [ownerZaloId]
        );
    }

    // ─── Telegram Channel Recovery Queue (persistent) ───────────────────────

    /** Enqueue a channel for post-reconnect recovery. PTS takes the lower of
     *  existing and new values to avoid missing messages in the gap. */
    public enqueueChannelRecovery(
        ownerZaloId: string,
        channelId: string,
        accessHash: string,
        pts: number,
        priority = 0,
    ): void {
        if (!this.initialized || !ownerZaloId || !channelId) return;
        const now = Date.now();
        // GramJS exposes `accessHash` as a Long/BigInteger object. SQLite only
        // accepts primitive bind values, so normalize every queue value at the
        // persistence boundary rather than trusting each caller to do it.
        const normalizedAccessHash = accessHash == null ? '' : String(accessHash);
        const toFiniteNumber = (value: unknown, fallback: number): number => {
            try {
                const numeric = Number((value as any)?.valueOf?.() ?? value);
                return Number.isFinite(numeric) ? numeric : fallback;
            } catch {
                return fallback;
            }
        };
        const normalizedPts = Math.max(0, Math.floor(toFiniteNumber(pts, 0)));
        const normalizedPriority = Math.max(0, Math.floor(toFiniteNumber(priority, 0)));
        // A row parked as `not_member` (see reconcileChannelRecoveryMembership)
        // reopens only once the account is a verified member again; otherwise
        // every re-enqueue would flip it back to an undequeueable `pending`.
        const reopenParked = this.isVerifiedTelegramChannelMember(String(ownerZaloId), String(channelId));
        // The final value binds `updated_at = ?` in the conflict-update
        // branch, in addition to created_at/updated_at used on INSERT.
        this.run(`
            INSERT INTO telegram_channel_recovery_queue
                (owner_zalo_id, channel_id, access_hash, pts, status, priority, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
            ON CONFLICT(owner_zalo_id, channel_id) DO UPDATE SET
                access_hash = CASE WHEN excluded.access_hash != '' THEN excluded.access_hash ELSE telegram_channel_recovery_queue.access_hash END,
                pts = CASE WHEN excluded.pts > 0 AND (telegram_channel_recovery_queue.pts = 0 OR excluded.pts < telegram_channel_recovery_queue.pts)
                    THEN excluded.pts ELSE telegram_channel_recovery_queue.pts END,
                -- A fresh socket PTS gap is authoritative evidence that a
                -- previously failed recovery must be tried again. Keeping a
                -- failed row terminal made a supergroup/channel permanently
                -- ignore every subsequent realtime update. A parked row
                -- reopens once the account is a member again.
                status = CASE
                    WHEN telegram_channel_recovery_queue.status IN ('complete', 'unavailable', 'failed') THEN 'pending'
                    WHEN telegram_channel_recovery_queue.status = 'not_member' AND ? = 1 THEN 'pending'
                    ELSE telegram_channel_recovery_queue.status END,
                history_start_msg_id = CASE WHEN telegram_channel_recovery_queue.status IN ('complete', 'unavailable', 'failed')
                      OR (telegram_channel_recovery_queue.status = 'not_member' AND ? = 1)
                    THEN NULL ELSE telegram_channel_recovery_queue.history_start_msg_id END,
                priority = CASE WHEN excluded.priority > telegram_channel_recovery_queue.priority
                    THEN excluded.priority ELSE telegram_channel_recovery_queue.priority END,
                retry_at = CASE WHEN telegram_channel_recovery_queue.status IN ('complete', 'unavailable', 'failed', 'not_member')
                    THEN 0 ELSE telegram_channel_recovery_queue.retry_at END,
                -- TG-05: updated_at is the lease clock used by
                -- requeueStaleChannelRecoveries. A live PTS-gap hint is not a
                -- worker heartbeat: bumping it here let a dead worker's lease
                -- look permanently fresh and stopped the job from ever being
                -- reclaimed. Only a real status transition (the worker's own
                -- updateChannelRecoveryStatus) renews the lease.
                updated_at = CASE WHEN telegram_channel_recovery_queue.status = 'draining'
                    THEN telegram_channel_recovery_queue.updated_at ELSE ? END
        `, [String(ownerZaloId), String(channelId), normalizedAccessHash, normalizedPts, normalizedPriority, now, now,
            reopenParked ? 1 : 0, reopenParked ? 1 : 0, now]);
        this.preserveChannelRecoveryHistoryStart(String(ownerZaloId), String(channelId));
    }

    /** Membership verified from a dialog/entity reconciliation (the condition dequeue applies). */
    private isVerifiedTelegramChannelMember(ownerZaloId: string, channelId: string): boolean {
        return !!this.queryOne<{ member: number }>(
            `SELECT 1 AS member FROM contacts
             WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'telegram_user'
               AND telegram_membership_state = 'member' AND COALESCE(telegram_state_updated_at, 0) > 0`,
            [ownerZaloId, channelId],
        )?.member;
    }

    /**
     * Keep the recovery queue consistent with membership. Rows are kept but
     * parked as `not_member` when the conversation says the account is not a
     * member (left, never joined, pending request, forbidden), or when no
     * conversation exists a day after the row was queued (rows left behind by
     * older builds). Dequeue never takes such rows, and left `pending` they
     * kept the poller rescheduling itself. A parked row reopens once the
     * account is a verified member again. `draining` rows belong to a worker;
     * a fresh row whose conversation is not verified yet stays pending.
     */
    public reconcileChannelRecoveryMembership(ownerZaloId: string, orphanAfterMs = 24 * 60 * 60 * 1000): { parked: number; reopened: number } {
        if (!this.initialized || !ownerZaloId) return { parked: 0, reopened: 0 };
        const now = Date.now();
        const sameConversation = `contact.owner_zalo_id = telegram_channel_recovery_queue.owner_zalo_id
              AND contact.contact_id = telegram_channel_recovery_queue.channel_id
              AND contact.channel = 'telegram_user'`;
        const verifiedMember = `EXISTS (
            SELECT 1 FROM contacts AS contact
            WHERE ${sameConversation}
              AND contact.telegram_membership_state = 'member'
              AND COALESCE(contact.telegram_state_updated_at, 0) > 0)`;
        const parked = this.runChanges(`
            UPDATE telegram_channel_recovery_queue
            SET status = 'not_member', priority = 0, retry_at = 0, history_start_msg_id = NULL,
                last_error = 'not_member', updated_at = ?
            WHERE owner_zalo_id = ? AND status IN ('pending', 'failed') AND (
              EXISTS (
                SELECT 1 FROM contacts AS contact
                WHERE ${sameConversation}
                  AND COALESCE(contact.telegram_membership_state, 'member') != 'member')
              OR (
                NOT EXISTS (SELECT 1 FROM contacts AS contact WHERE ${sameConversation})
                AND COALESCE(created_at, 0) < ?)
            )
        `, [now, ownerZaloId, now - Math.max(0, orphanAfterMs)]);
        const reopened = this.runChanges(`
            UPDATE telegram_channel_recovery_queue
            SET status = 'pending', retry_at = 0, last_error = NULL, updated_at = ?
            WHERE owner_zalo_id = ? AND status = 'not_member' AND ${verifiedMember}
        `, [now, ownerZaloId]);
        return { parked, reopened };
    }

    /**
     * When the next recovery the workers can actually take becomes due:
     * `null` when there is none, `now` when one is due already, otherwise the
     * earliest flood/backoff retry time. Uses the same eligibility as
     * dequeueChannelRecovery, so unrecoverable rows never schedule a poll.
     */
    public getNextChannelRecoveryRunAt(ownerZaloId: string): number | null {
        if (!this.initialized || !ownerZaloId) return null;
        const now = Date.now();
        const row = this.queryOne<{ due: number; next_at: number | null }>(
            `SELECT
               SUM(CASE WHEN queue.retry_at = 0 OR queue.retry_at <= ? THEN 1 ELSE 0 END) AS due,
               MIN(CASE WHEN queue.retry_at > ? THEN queue.retry_at END) AS next_at
             FROM telegram_channel_recovery_queue AS queue
             INNER JOIN contacts AS contact
               ON contact.owner_zalo_id = queue.owner_zalo_id
              AND contact.contact_id = queue.channel_id
              AND contact.channel = 'telegram_user'
             WHERE queue.owner_zalo_id = ?
               AND queue.status = 'pending'
               AND contact.telegram_membership_state = 'member'
               AND COALESCE(contact.telegram_state_updated_at, 0) > 0`,
            [now, now, ownerZaloId],
        );
        if (Number(row?.due || 0) > 0) return now;
        return row?.next_at ? Number(row.next_at) : null;
    }

    /** Freeze the history lower bound BEFORE a live message raises MAX(msg_id).
     * PTS recovery may fall back to history; newest live delivery must not hide
     * the older missing interval. Zero is a valid frozen first-load boundary.
     * Mốc = mã tin lớn nhất trong 200 tin mới nhất (telegramTopMessage.ts), không quét cả kênh. */
    public preserveChannelRecoveryHistoryStart(ownerZaloId: string, channelId: string): void {
        if (!this.initialized) return;
        this.run(`UPDATE telegram_channel_recovery_queue
            SET history_start_msg_id = ${TELEGRAM_TOP_MESSAGE_ID_SQL}
            WHERE owner_zalo_id = ? AND channel_id = ?
              AND status IN ('pending', 'draining') AND history_start_msg_id IS NULL`,
            [...telegramTopMessageIdParams(ownerZaloId, channelId), ownerZaloId, channelId]);
    }

    /** Dequeue up to `limit` channels ready for recovery (pending + not throttled). */
    public dequeueChannelRecovery(
        ownerZaloId: string,
        limit = 20,
    ): Array<{ channel_id: string; access_hash: string; pts: number; priority: number; attempts: number }> {
        if (!this.initialized || !ownerZaloId) return [];
        const now = Date.now();
        return this.query<any>(
            `SELECT queue.channel_id, queue.access_hash, queue.pts, queue.priority, queue.attempts
             FROM telegram_channel_recovery_queue AS queue
             LEFT JOIN contacts AS contact
               ON contact.owner_zalo_id = queue.owner_zalo_id
              AND contact.contact_id = queue.channel_id
              AND contact.channel = 'telegram_user'
             WHERE queue.owner_zalo_id = ?
               AND queue.status = 'pending'
               AND (queue.retry_at = 0 OR queue.retry_at <= ?)
               AND contact.telegram_membership_state = 'member'
               AND COALESCE(contact.telegram_state_updated_at, 0) > 0
             ORDER BY
               -- A live PTS gap is urgent regardless of the folder. Normal
               -- reconnect work always drains the visible "Tất cả" folder
               -- before Archived/Khác.
               CASE WHEN queue.priority >= 1000 THEN 1 ELSE 0 END DESC,
               CASE WHEN COALESCE(contact.telegram_folder_id, 0) = 0
                          AND COALESCE(contact.is_in_others, 0) = 0
                    THEN 1 ELSE 0 END DESC,
               CASE WHEN COALESCE(contact.unread_count, 0) > 0 THEN 1 ELSE 0 END DESC,
               COALESCE(contact.last_message_time, 0) DESC,
               queue.retry_at ASC,
               queue.created_at ASC
             LIMIT ?`,
            [ownerZaloId, now, limit],
        );
    }

    /**
     * Dequeue only recovery work caused by a live channel PTS gap or
     * UpdateChannelTooLong. Reconnect can have thousands of historical
     * channels queued; those must never delay a message that arrived while
     * the application is already online.
     */
    public dequeueUrgentChannelRecovery(
        ownerZaloId: string,
        limit = 20,
    ): Array<{ channel_id: string; access_hash: string; pts: number; priority: number; attempts: number }> {
        if (!this.initialized || !ownerZaloId) return [];
        const now = Date.now();
        return this.query<any>(
            `SELECT queue.channel_id, queue.access_hash, queue.pts, queue.priority, queue.attempts
             FROM telegram_channel_recovery_queue AS queue
             INNER JOIN contacts AS contact
               ON contact.owner_zalo_id = queue.owner_zalo_id
              AND contact.contact_id = queue.channel_id
              AND contact.channel = 'telegram_user'
             WHERE queue.owner_zalo_id = ?
               AND queue.status = 'pending'
               AND queue.priority >= 1000
               AND (queue.retry_at = 0 OR queue.retry_at <= ?)
               AND contact.telegram_membership_state = 'member'
               AND COALESCE(contact.telegram_state_updated_at, 0) > 0
             ORDER BY priority DESC, updated_at ASC, created_at ASC
             LIMIT ?`,
            [ownerZaloId, now, limit],
        );
    }

    /** Whether a live channel recovery is ready to run. */
    public hasPendingUrgentChannelRecovery(ownerZaloId: string): boolean {
        if (!this.initialized || !ownerZaloId) return false;
        const now = Date.now();
        return !!this.queryOne<{ pending: number }>(
            `SELECT 1 AS pending
             FROM telegram_channel_recovery_queue AS queue
             INNER JOIN contacts AS contact
               ON contact.owner_zalo_id = queue.owner_zalo_id
              AND contact.contact_id = queue.channel_id
              AND contact.channel = 'telegram_user'
             WHERE queue.owner_zalo_id = ?
               AND queue.status = 'pending'
               AND queue.priority >= 1000
               AND (queue.retry_at = 0 OR queue.retry_at <= ?)
               AND contact.telegram_membership_state = 'member'
               AND COALESCE(contact.telegram_state_updated_at, 0) > 0
             LIMIT 1`,
            [ownerZaloId, now],
        )?.pending;
    }

    /** Complete a recovery and clear its transient live-priority marker. */
    public completeChannelRecovery(ownerZaloId: string, channelId: string): void {
        if (!this.initialized || !ownerZaloId || !channelId) return;
        this.run(
            `UPDATE telegram_channel_recovery_queue
             SET status = 'complete', priority = 0, retry_at = 0,
                 history_start_msg_id = NULL, last_error = NULL, updated_at = ?
             WHERE owner_zalo_id = ? AND channel_id = ?`,
            [Date.now(), ownerZaloId, channelId],
        );
    }

    /**
     * A process crash can leave a leased channel marked draining forever.
     * Requeue only leases old enough that no in-process worker can still own
     * them; active workers update the row on every terminal outcome.
     */
    public requeueStaleChannelRecoveries(ownerZaloId: string, staleAfterMs = 5 * 60 * 1000): void {
        if (!this.initialized || !ownerZaloId) return;
        const now = Date.now();
        this.run(
            `UPDATE telegram_channel_recovery_queue
             SET status = 'pending',
                 last_error = 'stale_draining_requeued',
                 updated_at = ?
             WHERE owner_zalo_id = ?
               AND status = 'draining'
               AND updated_at < ?`,
            [now, ownerZaloId, now - Math.max(1, staleAfterMs)],
        );
    }

    /** Update recovery status. Pass retryAt to schedule a delayed retry (flood wait). */
    public updateChannelRecoveryStatus(
        ownerZaloId: string,
        channelId: string,
        status: 'pending' | 'draining' | 'complete' | 'failed' | 'unavailable' | 'not_member',
        opts?: { retryAt?: number; lastError?: string; lastMsgId?: number; pts?: number },
    ): void {
        if (!this.initialized || !ownerZaloId || !channelId) return;
        const now = Date.now();
        this.run(`
            UPDATE telegram_channel_recovery_queue
            SET status = ?,
                retry_at = COALESCE(?, retry_at),
                last_error = COALESCE(?, last_error),
                last_msg_id = COALESCE(?, last_msg_id),
                pts = CASE WHEN ? > 0 AND ? > pts THEN ? ELSE pts END,
                attempts = attempts + 1,
                updated_at = ?
            WHERE owner_zalo_id = ? AND channel_id = ?
        `, [
            status,
            opts?.retryAt ?? null,
            opts?.lastError ?? null,
            opts?.lastMsgId ?? null,
            opts?.pts ?? 0, opts?.pts ?? 0, opts?.pts ?? 0,
            now, ownerZaloId, channelId,
        ]);
    }

    /** Get recovery stats for UI progress display. */
    public getChannelRecoveryStats(ownerZaloId: string): {
        pending: number; draining: number; complete: number; failed: number; unavailable: number; not_member: number;
    } {
        if (!this.initialized || !ownerZaloId) return { pending: 0, draining: 0, complete: 0, failed: 0, unavailable: 0, not_member: 0 };
        const rows = this.query<any>(
            `SELECT status, COUNT(*) as count FROM telegram_channel_recovery_queue
             WHERE owner_zalo_id = ? GROUP BY status`,
            [ownerZaloId],
        );
        const stats = { pending: 0, draining: 0, complete: 0, failed: 0, unavailable: 0, not_member: 0 };
        for (const row of rows) {
            if (row.status in stats) (stats as any)[row.status] = row.count;
        }
        return stats;
    }

    /** Remove completed/unavailable entries older than threshold to prevent unbounded growth. */
    public cleanupChannelRecoveryQueue(ownerZaloId: string, olderThanMs = 24 * 60 * 60 * 1000): void {
        if (!this.initialized || !ownerZaloId) return;
        const cutoff = Date.now() - olderThanMs;
        this.run(
            `DELETE FROM telegram_channel_recovery_queue
             WHERE owner_zalo_id = ?
               AND status IN ('complete', 'unavailable')
               AND updated_at < ?`,
            [ownerZaloId, cutoff],
        );
    }

    /** Get channel IDs eligible for background recovery. Old/unjoined channel
     * history must never repopulate the recovery queue: it creates a flood of
     * ChannelDifference requests and starves channels the account still uses. */
    public getTelegramChannelIdsWithMessages(ownerZaloId: string): string[] {
        if (!this.initialized || !ownerZaloId) return [];
        // Đi từ bảng contacts (nhỏ) và dò EXISTS trong messages qua idx_messages_channel,
        // thay vì quét toàn bộ messages rồi DISTINCT thread_id (chậm khi nhiều tin).
        return this.query<{ thread_id: string }>(
            `SELECT contact.contact_id AS thread_id
             FROM contacts AS contact
             WHERE contact.owner_zalo_id = ? AND contact.channel = 'telegram_user'
               AND contact.telegram_membership_state = 'member'
               AND COALESCE(contact.telegram_state_updated_at, 0) > 0
               AND contact.contact_id LIKE '-100%'
               AND EXISTS (
                 SELECT 1 FROM messages AS m
                 WHERE m.owner_zalo_id = ? AND m.channel = 'telegram_user'
                   AND m.thread_id = contact.contact_id
                 LIMIT 1
               )
             UNION
             SELECT contact.contact_id AS thread_id
             FROM contacts AS contact
             INNER JOIN telegram_channel_pts AS cursor
               ON cursor.owner_zalo_id = contact.owner_zalo_id
              AND cursor.channel_id = contact.contact_id
             WHERE contact.owner_zalo_id = ? AND contact.channel = 'telegram_user'
               AND contact.telegram_membership_state = 'member'
               AND COALESCE(contact.telegram_state_updated_at, 0) > 0`,
            [ownerZaloId, ownerZaloId, ownerZaloId],
        ).map(r => r.thread_id);
    }


    // ─── Telegram Bot durable cursor ────────────────────────────────────────

    public getBotCursor(tokenHash: string): number {
        if (!this.initialized || !tokenHash) return 0;
        const row = this.queryOne<any>(
            `SELECT offset_value FROM telegram_bot_cursor WHERE bot_token_hash = ?`,
            [tokenHash]
        );
        return row?.offset_value ?? 0;
    }

    public setBotCursor(tokenHash: string, offset: number): void {
        if (!this.initialized || !tokenHash) return;
        const now = new Date().toISOString();
        this.run(`
            INSERT INTO telegram_bot_cursor (bot_token_hash, offset_value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(bot_token_hash) DO UPDATE SET
                offset_value = excluded.offset_value,
                updated_at = excluded.updated_at
        `, [tokenHash, offset, now]);
    }

    public deleteBotCursor(tokenHash: string): void {
        if (!this.initialized || !tokenHash) return;
        this.run(`DELETE FROM telegram_bot_cursor WHERE bot_token_hash = ?`, [tokenHash]);
    }

    public saveAccount(account: Omit<Account, 'id'>): void {
        if (!this.initialized) return;
        const normalizedPhone = this.normalizeVietnamPhone(account.phone || '');
        // Mọi kênh: cookie Zalo, phiên GramJS, token bot Telegram (trước đây chỉ mã hoá chuỗi dạng JSON)
        const cookiesToStore = this.encryptCookiesForStorage(account.cookies);

        // Không truyền is_business = chưa biết (vd đăng nhập QR lưu tài khoản trước khi hỏi bizPkg) → giữ giá trị đang lưu,
        // tài khoản mới = 0. Trước đây mặc định 0 ghi đè luôn cờ của tài khoản Zalo Business.
        const isBusiness = account.is_business ?? null;
        const channel = (account as any).channel || CHANNEL.ZALO;
        const username = (account as any).username || '';
        this.run(
            `INSERT INTO accounts (zalo_id, full_name, avatar_url, phone, username, is_business, imei, user_agent, cookies, is_active, created_at, channel)
             VALUES (?,?,?,?,?,COALESCE(?, 0),?,?,?,?,?,?)
             ON CONFLICT(zalo_id) DO UPDATE SET
               full_name=excluded.full_name,
               avatar_url=excluded.avatar_url,
               phone=excluded.phone,
               username=excluded.username,
               is_business=COALESCE(?, accounts.is_business),
               imei=excluded.imei,
               user_agent=excluded.user_agent,
               cookies=excluded.cookies,
               is_active=excluded.is_active,
               channel=excluded.channel,
               last_seen=datetime('now')`,
            [account.zalo_id, account.full_name, account.avatar_url, normalizedPhone, username, isBusiness, account.imei, account.user_agent, cookiesToStore, account.is_active, account.created_at, channel, isBusiness]
        );
    }

    public getAccounts(): Account[] {
        if (!this.initialized) return [];
        const accounts = this.query<Account>('SELECT * FROM accounts WHERE is_active = 1 ORDER BY created_at');
        return accounts.map((acc) => ({ ...acc, cookies: this.decryptCookies(acc.cookies) }));
    }

    /** Ghi phiên Zalo mới nhất của một kết nối (đồng bộ khi đổi workspace) — mã hoá như saveAccount. */
    public updateAccountAuth(zaloId: string, cookies: string, imei: string, userAgent: string): void {
        this.run(
            `UPDATE accounts SET cookies = ?, imei = ?, user_agent = ? WHERE zalo_id = ?`,
            [this.encryptCookiesForStorage(cookies), imei, userAgent, zaloId],
        );
    }

    /**
     * Mã hoá phiên đăng nhập trước khi ghi accounts.cookies bằng safeStorage — chỉ máy + tài khoản Windows này giải mã
     * được (dev và bản cài dùng chung userData %APPDATA%\Deplao nên chung khoá). Giá trị đã mã hoá (giải mã được) giữ
     * nguyên, không mã hoá hai lần; safeStorage chưa sẵn sàng → lưu nguyên, encryptStoredCredentials mã hoá ở lần mở DB sau.
     */
    private encryptCookiesForStorage(value: string | null | undefined): string {
        const plain = value ?? '';
        if (!plain) return plain;
        try {
            if (!safeStorage.isEncryptionAvailable()) return plain;
            if (this.tryDecryptStored(plain) !== null) return plain;
            return safeStorage.encryptString(plain).toString('base64');
        } catch {
            return plain;
        }
    }

    /** Giải mã một giá trị safeStorage (base64); null = không phải bản mã hoá của máy này. */
    private tryDecryptStored(value: string): string | null {
        try {
            return safeStorage.decryptString(Buffer.from(value, 'base64'));
        } catch {
            return null;
        }
    }

    /**
     * Mã hoá phiên đăng nhập còn nằm thô trong DB — chạy mỗi lần mở DB (idempotent, chỉ khi safeStorage sẵn sàng):
     *  - accounts.cookies: phiên Telegram / token bot (trước đây không mã hoá), cookie Zalo ghi thô (safeStorage chưa
     *    sẵn sàng, đồng bộ khi đổi workspace). Hàng Facebook: bản sao cookie thô của migration B3, không nơi nào đọc → xoá.
     *  - fb_accounts.cookie_encrypted (tên cột nhầm — cookie THÔ, dự phòng khi khoá safeStorage đổi): chuyển vào secure
     *    storage (fb_cookie_<id>, mã hoá) nếu chưa có bản đọc được rồi xoá; tài khoản đã gỡ (accounts.is_active = 0) chỉ xoá.
     */
    private encryptStoredCredentials(): void {
        try {
            if (!safeStorage.isEncryptionAvailable()) return;
        } catch {
            return;
        }
        let encrypted = 0;
        let cleared = 0;
        try {
            const rows = this.query<{ zalo_id: string; cookies: string; channel: string | null }>(
                `SELECT zalo_id, cookies, channel FROM accounts WHERE cookies IS NOT NULL AND cookies <> ''`,
            );
            for (const row of rows) {
                if (row.channel === 'facebook') {
                    this.run(`UPDATE accounts SET cookies = '' WHERE zalo_id = ?`, [row.zalo_id]);
                    cleared++;
                    continue;
                }
                const stored = this.encryptCookiesForStorage(row.cookies);
                if (stored !== row.cookies) {
                    this.run(`UPDATE accounts SET cookies = ? WHERE zalo_id = ?`, [stored, row.zalo_id]);
                    encrypted++;
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] encryptStoredCredentials (accounts): ${err.message}`);
        }
        try {
            const fbRows = this.query<{ id: string; facebook_id: string | null; cookie_encrypted: string }>(
                `SELECT id, facebook_id, cookie_encrypted FROM fb_accounts WHERE cookie_encrypted IS NOT NULL AND cookie_encrypted <> ''`,
            );
            if (fbRows.length) {
                // Lazy require: SecureSettingsService import DatabaseService
                const { secureGet, secureSet } = require('../secure/SecureSettingsService');
                for (const fb of fbRows) {
                    const unified = fb.facebook_id
                        ? this.queryOne<{ is_active: number }>('SELECT is_active FROM accounts WHERE zalo_id = ?', [fb.facebook_id])
                        : undefined;
                    if (unified && Number(unified.is_active) === 0) {
                        this.clearFBAccountSession(fb.id);
                        cleared++;
                        continue;
                    }
                    const key = `fb_cookie_${fb.id}`;
                    if (!secureGet(key)) {
                        secureSet(key, fb.cookie_encrypted);
                        if (secureGet(key) !== fb.cookie_encrypted) continue; // không lưu được bản mã hoá → giữ dự phòng thô
                    }
                    this.run(`UPDATE fb_accounts SET cookie_encrypted = '' WHERE id = ?`, [fb.id]);
                    cleared++;
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] encryptStoredCredentials (fb_accounts): ${err.message}`);
        }
        if (encrypted || cleared) {
            Logger.log(`[DatabaseService] Credentials at rest: encrypted ${encrypted} session(s), removed ${cleared} raw cookie copy(ies)`);
        }
    }

    public deleteAccount(zaloId: string): void {
        this.run('UPDATE accounts SET is_active = 0 WHERE zalo_id = ?', [zaloId]);
    }

    /**
     * Hội thoại "My Documents" của tài khoản Zalo đã có trong DB: hồ sơ Zalo trả ảnh thư mục riêng
     * (`zds_cic_my_documents_*`) — dùng khi chưa biết `send2me_id` (chưa kết nối từ bản này) và để đối chiếu.
     */
    public findMyDocumentsContactId(ownerZaloId: string): string {
        if (!this.initialized || !ownerZaloId) return '';
        const row = this.queryOne<{ contact_id: string }>(
            `SELECT contact_id FROM contacts
             WHERE owner_zalo_id = ? AND avatar_url LIKE '%zds_cic_my_documents%'
             ORDER BY COALESCE(last_message_time, 0) DESC LIMIT 1`,
            [ownerZaloId],
        );
        return row?.contact_id ? String(row.contact_id) : '';
    }

    /** ID hội thoại My Documents của một tài khoản (đọc từ getAccounts): send2me_id đã lưu, chưa có thì tìm theo ảnh. */
    public resolveMyDocumentsId(account: { zalo_id: string; channel?: string | null; send2me_id?: string | null }): string {
        if (!account?.zalo_id || (account.channel && account.channel !== 'zalo')) return '';
        if (account.send2me_id) return String(account.send2me_id);
        try { return this.findMyDocumentsContactId(account.zalo_id); } catch { return ''; }
    }

    /** resolveMyDocumentsId theo zalo_id (SELECT * — không lỗi với DB chưa có cột send2me_id). */
    public getMyDocumentsId(zaloId: string): string {
        if (!this.initialized || !zaloId) return '';
        try {
            const acc = this.queryOne<any>('SELECT * FROM accounts WHERE zalo_id = ?', [zaloId]);
            return acc ? this.resolveMyDocumentsId(acc) : '';
        } catch {
            return '';
        }
    }

    /** Lưu ID hội thoại My Documents của tài khoản Zalo (chỉ ghi khi đổi). */
    public setAccountSend2MeId(zaloId: string, send2meId: string): void {
        if (!this.initialized || !zaloId || !send2meId) return;
        this.run(
            `UPDATE accounts SET send2me_id = ? WHERE zalo_id = ? AND COALESCE(send2me_id, '') != ?`,
            [send2meId, zaloId, send2meId],
        );
    }

    /**
     * Xoá HOÀN TOÀN tài khoản và tất cả dữ liệu liên quan (hard delete).
     * Gọi disconnect trước đó để đảm bảo listener/connection được cleanup.
     * Hỗ trợ cả Zalo và Facebook accounts.
     */
    public deleteAccountData(zaloId: string): void {
        if (!this.initialized) return;
        Logger.log(`[DatabaseService] Permanently deleting all data for account: ${zaloId}`);

        // Kiểm tra nếu là FB account → cần xử lý FB-specific tables riêng
        const account = this.queryOne<{ channel?: string }>('SELECT channel FROM accounts WHERE zalo_id = ?', [zaloId]);
        const isFB = account?.channel === 'facebook';

        if (isFB) {
            // FB account: xoá dữ liệu FB-specific qua UUID từ fb_accounts
            const fbAcc = this.queryOne<{ id: string }>('SELECT id FROM fb_accounts WHERE facebook_id = ?', [zaloId]);
            if (fbAcc?.id) {
                this.run('DELETE FROM fb_messages WHERE account_id = ?', [fbAcc.id]);
                this.run('DELETE FROM fb_threads WHERE account_id = ?', [fbAcc.id]);
                this.run('DELETE FROM fb_crm_contacts WHERE fb_account_id = ?', [fbAcc.id]);
                this.run('DELETE FROM fb_accounts WHERE id = ?', [fbAcc.id]);
            }
        }

        // Zalo tables (có owner_zalo_id column) - chạy an toàn, không ảnh hưởng nếu ko có row
        this.run('DELETE FROM messages WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM contacts WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM friends WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM page_group_member WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM telegram_peers WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM telegram_update_state WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM telegram_channel_pts WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM telegram_channel_recovery_queue WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM links WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM friend_requests WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM pinned_messages WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM local_quick_messages WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM local_label_threads WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM local_pinned_conversations WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM message_drafts WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM bank_cards WHERE owner_zalo_id = ?', [zaloId]);

        // CRM tables
        this.run('DELETE FROM crm_tags WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM crm_contact_tags WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM crm_notes WHERE owner_zalo_id = ?', [zaloId]);
        this.run('DELETE FROM crm_send_log WHERE owner_zalo_id = ?', [zaloId]);

        // CRM campaigns (xoá campaign_contacts trước)
        this.run(`DELETE FROM crm_campaign_contacts WHERE campaign_id IN (SELECT id FROM crm_campaigns WHERE owner_zalo_id = ?)`, [zaloId]);
        this.run('DELETE FROM crm_campaigns WHERE owner_zalo_id = ?', [zaloId]);

        // Workflows - page_ids là comma-separated list of account IDs
        // Nếu workflow chỉ gắn với account này → xoá cả workflow
        // Nếu workflow gắn với nhiều account → chỉ gỡ account này khỏi page_ids
        try {
            const wfRows = this.query<{ id: string; page_ids: string }>('SELECT id, page_ids FROM workflows WHERE page_ids LIKE ?', [`%${zaloId}%`]);
            for (const wf of wfRows) {
                const ids = (wf.page_ids || '').split(',').filter(Boolean);
                if (ids.length <= 1) {
                    // Chỉ có account này → xoá cả workflow
                    this.run('DELETE FROM workflow_run_logs WHERE workflow_id = ?', [wf.id]);
                    this.run('DELETE FROM workflows WHERE id = ?', [wf.id]);
                } else {
                    // Nhiều account → chỉ gỡ account này khỏi page_ids
                    const newIds = ids.filter(id => id !== zaloId).join(',');
                    this.run('UPDATE workflows SET page_ids = ? WHERE id = ?', [newIds, wf.id]);
                }
            }
        } catch { /* workflows table may not have page_ids column on very old DBs */ }

        // Integrations - không có owner_zalo_id, bỏ qua (integration không gắn với account cụ thể)
        // Ai assistant data - không có owner_zalo_id, bỏ qua

        // Employee access (dùng zalo_id column)
        this.run('DELETE FROM employee_account_access WHERE zalo_id = ?', [zaloId]);
        this.run('DELETE FROM employee_message_log WHERE zalo_id = ?', [zaloId]);

        // Notification settings + media auto-delete config
        this.run("DELETE FROM app_settings WHERE key LIKE ?", [`notif_${zaloId}%`]);
        this.run("DELETE FROM app_settings WHERE key = ?", [`media_auto_delete_${zaloId}`]);

        // Cuối cùng: hard-delete account
        this.run('DELETE FROM accounts WHERE zalo_id = ?', [zaloId]);

        Logger.log(`[DatabaseService] Deleted all data for account: ${zaloId} (isFB=${isFB})`);
    }

    /**
     * Lấy cấu hình tự động xoá media cho tài khoản
     */
    public getMediaAutoDeleteConfig(zaloId: string): { enabled: boolean; days: number } | null {
        if (!this.initialized) return null;
        const val = this.getSetting(`media_auto_delete_${zaloId}`);
        if (!val) return null;
        try {
            return JSON.parse(val) as { enabled: boolean; days: number };
        } catch {
            return null;
        }
    }

    /**
     * Lưu cấu hình tự động xoá media cho tài khoản
     */
    public setMediaAutoDeleteConfig(zaloId: string, config: { enabled: boolean; days: number }): void {
        if (!this.initialized) return;
        this.setSetting(`media_auto_delete_${zaloId}`, JSON.stringify(config));
    }

    public updateAccountLastSeen(zaloId: string): void {
        this.run('UPDATE accounts SET last_seen = datetime(\'now\') WHERE zalo_id = ?', [zaloId]);
    }

    /** Cập nhật số điện thoại cho tài khoản */
    public updateAccountPhone(zaloId: string, phone: string): void {
        if (!this.initialized) return;
        this.run('UPDATE accounts SET phone = ? WHERE zalo_id = ?', [this.normalizeVietnamPhone(phone), zaloId]);
    }

    /**
     * Cập nhật thông tin profile: phone + is_business + avatar_url + full_name.
     * SĐT rỗng / isBusiness null = giữ giá trị đang lưu (Zalo trả thiếu thì không xoá SĐT hay cờ Business).
     */
    public updateAccountInfo(zaloId: string, phone: string, isBusiness: number | null, avatarUrl?: string, fullName?: string): void {
        if (!this.initialized) return;
        const fields: string[] = [];
        const values: any[] = [];
        const normalizedPhone = this.normalizeVietnamPhone(phone);
        if (normalizedPhone) {
            fields.push('phone = ?');
            values.push(normalizedPhone);
        }
        if (isBusiness === 0 || isBusiness === 1) {
            fields.push('is_business = ?');
            values.push(isBusiness);
        }
        if (avatarUrl !== undefined) {
            fields.push('avatar_url = ?');
            values.push(avatarUrl);
        }
        if (fullName !== undefined) {
            fields.push('full_name = ?');
            values.push(fullName);
        }
        if (!fields.length) return;
        values.push(zaloId);
        this.run(
            `UPDATE accounts SET ${fields.join(', ')} WHERE zalo_id = ?`,
            values
        );
    }

    /** Ghi cờ Zalo Business (0 / 1) của tài khoản; true khi giá trị thật sự đổi (để báo giao diện). */
    public setAccountBusiness(zaloId: string, isBusiness: 0 | 1): boolean {
        if (!this.initialized) return false;
        const row = this.queryOne<{ is_business: number | null }>('SELECT is_business FROM accounts WHERE zalo_id = ?', [zaloId]);
        if (!row || Number(row.is_business || 0) === isBusiness) return false;
        this.run('UPDATE accounts SET is_business = ? WHERE zalo_id = ?', [isBusiness, zaloId]);
        return true;
    }

    /** Kiểm tra tài khoản đã tồn tại trong DB chưa */
    public hasAccount(zaloId: string): boolean {
        if (!this.initialized) return false;
        return !!this.queryOne<any>('SELECT id FROM accounts WHERE zalo_id = ?', [zaloId]);
    }

    /** Đánh dấu trạng thái listener (1 = active, 0 = dead/failed) */
    public setListenerActive(zaloId: string, active: boolean): void {
        this.run('UPDATE accounts SET listener_active = ? WHERE zalo_id = ?', [active ? 1 : 0, zaloId]);
    }

    // ─── Proxy CRUD ───────────────────────────────────────────────────────────

    /** Lưu proxy mới, trả về id */
    public saveProxy(proxy: { name: string; type: string; host: string; port: number; username?: string; password?: string }): number {
        const now = Date.now();
        const result = db!.prepare(
            `INSERT INTO proxies (name, type, host, port, username, password, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(proxy.name, proxy.type, proxy.host, proxy.port, proxy.username || '', proxy.password || '', now, now);
        return result.lastInsertRowid as number;
    }

    /** Cập nhật proxy theo id */
    public updateProxy(id: number, proxy: { name?: string; type?: string; host?: string; port?: number; username?: string; password?: string }): void {
        const now = Date.now();
        const sets: string[] = [];
        const vals: any[] = [];
        if (proxy.name !== undefined) { sets.push('name = ?'); vals.push(proxy.name); }
        if (proxy.type !== undefined) { sets.push('type = ?'); vals.push(proxy.type); }
        if (proxy.host !== undefined) { sets.push('host = ?'); vals.push(proxy.host); }
        if (proxy.port !== undefined) { sets.push('port = ?'); vals.push(proxy.port); }
        if (proxy.username !== undefined) { sets.push('username = ?'); vals.push(proxy.username); }
        if (proxy.password !== undefined) { sets.push('password = ?'); vals.push(proxy.password); }
        if (sets.length === 0) return;
        sets.push('updated_at = ?'); vals.push(now);
        vals.push(id);
        db!.prepare(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }

    /** Xóa proxy và gỡ khỏi mọi tài khoản đang dùng */
    public deleteProxy(id: number): void {
        db!.prepare(`UPDATE accounts SET proxy_id = NULL WHERE proxy_id = ?`).run(id);
        db!.prepare(`DELETE FROM proxies WHERE id = ?`).run(id);
    }

    /** Lấy danh sách proxies kèm số tài khoản đang dùng */
    public getProxies(): any[] {
        return this.query<any>(
            `SELECT p.*, COUNT(a.id) as account_count
             FROM proxies p
             LEFT JOIN accounts a ON a.proxy_id = p.id AND a.is_active = 1
             GROUP BY p.id
             ORDER BY p.created_at DESC`
        );
    }

    /** Lấy proxy theo id */
    public getProxyById(id: number): any | null {
        return this.queryOne<any>('SELECT * FROM proxies WHERE id = ?', [id]) || null;
    }

    /** Gắn/gỡ proxy cho tài khoản */
    public setAccountProxy(zaloId: string, proxyId: number | null): void {
        this.run('UPDATE accounts SET proxy_id = ? WHERE zalo_id = ?', [proxyId, zaloId]);
    }

    /** Lấy proxy đang gắn với tài khoản (null nếu không có) */
    public getAccountProxy(zaloId: string): any | null {
        return this.queryOne<any>(
            `SELECT p.* FROM proxies p
             INNER JOIN accounts a ON a.proxy_id = p.id
             WHERE a.zalo_id = ?`,
            [zaloId]
        ) || null;
    }

    /** Giải mã accounts.cookies đọc bằng SQL trực tiếp (getAccounts đã tự giải mã). */
    public decryptCookies(encrypted: string): string {
        // Fast-path: empty → nothing to decrypt (e.g., Facebook accounts in unified table)
        if (!encrypted) return encrypted;
        // Fast-path: already plain JSON (saved before encryption was added, or safeStorage was unavailable)
        const trimmed = encrypted.trimStart();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) return encrypted;
        // Fast-path: Telegram bot token format (digits:alphanumeric, e.g., "123456:ABC-DEF1234...")
        if (/^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) return encrypted;

        // Try safeStorage decryption — works for Zalo cookies encrypted by safeStorage (any prefix).
        // GramJS sessions (base64 of JSON) are NOT encrypted, so safeStorage.decryptString will
        // throw → we catch and return as-is.
        try {
            if (safeStorage.isEncryptionAvailable()) {
                const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
                // Sanity check for JSON cookies (Zalo/FB): must be parseable JSON
                if (decrypted.startsWith('[') || decrypted.startsWith('{')) {
                    JSON.parse(decrypted);
                }
                return decrypted;
            } else {
                Logger.warn('[DatabaseService] decryptCookies: safeStorage not available, returning raw value');
            }
        } catch (err: any) {
            // safeStorage failed: could be GramJS session (not encrypted), DPAPI mismatch, or corrupted data.
            // Return as-is — GramJS sessions work as plain base64; encrypted Zalo cookies will fail downstream
            // and user will see "connect_failed" (must re-login).
        }
        return encrypted;
    }

    // ─── Message Operations ───────────────────────────────────────────────

    /** Check if a message already exists in DB (by msg_id) - used to skip duplicate broadcasts */
    public hasMessage(ownerZaloId: string, msgId: string): boolean {
        if (!this.initialized || !msgId) return false;
        try {
            const rows = this.query<any>(
                'SELECT 1 FROM messages WHERE owner_zalo_id = ? AND msg_id = ? LIMIT 1',
                [ownerZaloId, msgId]
            );
            return rows.length > 0;
        } catch {
            return false;
        }
    }

    public async saveMessage(ownerZaloId: string, rawMessage: any): Promise<void> {
        if (!this.initialized) return;
        try {
            // zca-js đã tính sẵn isSelf và threadId đúng:
            // - isSelf = true khi uidFrom == "0" (mình gửi, selfListen)
            // - threadId = data.idTo (nếu mình gửi) hoặc data.uidFrom (nhận từ người khác)
            const isSent: boolean = rawMessage.isSelf === true;
            const threadId: string = rawMessage.threadId || '';

            // DEBUG: log toàn bộ raw fields để phát hiện lỗi
            Logger.log(`[DB.saveMessage] 📩 raw: isSelf=${rawMessage.isSelf} | type=${rawMessage.type} | threadId="${rawMessage.threadId}" | computed isSent=${isSent} | computed threadId="${threadId}" | data.uidFrom="${rawMessage.data?.uidFrom}" | data.idTo="${rawMessage.data?.idTo}" | data.msgId="${rawMessage.data?.msgId}" | top_keys=[${Object.keys(rawMessage).join(',')}]`);

            const row = this.buildZaloMessageRow(ownerZaloId, rawMessage);
            // Guard: bỏ qua nếu threadId không hợp lệ
            if (!row) {
                Logger.warn(`[DB.saveMessage] ⚠️ SKIPPED - invalid threadId="${threadId}". rawMessage.isSelf=${rawMessage.isSelf}, rawMessage.threadId=${rawMessage.threadId}. Có thể main process chưa được rebuild với code mới!`);
                return;
            }

            // Tin này đã được đồng bộ từ điện thoại trước đó với id tạm (mb_/cli_ — điện thoại không có id thật của tin
            // gửi từ máy khác) → đổi dòng đó sang id thật thay vì thêm bản thứ hai
            if (!this.upgradeSyntheticZaloRow(ownerZaloId, row)) {
                this.run(
                    `INSERT OR IGNORE INTO messages
                     (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, local_paths, status, quote_data)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    row.params
                );
            }
            // Tin Zalo có thời gian tự xoá (ms) → lưu để hiện đồng hồ; Deplao không xoá tin theo TTL
            const ttl = Number(rawMessage?.data?.ttl) || 0;
            if (ttl > 0) this.setMessageTtl(ownerZaloId, String(row.params[0]), ttl);

            this.updateContactLastMessage(
                ownerZaloId, row.threadId,
                row.isGroup ? 1 : 0,
                row.content,
                row.msgType,
                row.timestamp,
                !row.isSent
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveMessage error: ${err.message}`);
        }
    }

    /**
     * Map 1 message dạng zca-js (UserMessage/GroupMessage) → tham số INSERT bảng messages.
     * Dùng chung cho saveMessage (realtime) và saveHistoryMessagesBulk (đồng bộ từ điện thoại).
     * Trả null nếu threadId không hợp lệ.
     */
    private buildZaloMessageRow(ownerZaloId: string, rawMessage: any): {
        threadId: string; isGroup: boolean; isSent: boolean;
        content: string; msgType: string; timestamp: number; params: any[];
    } | null {
        const isGroup = rawMessage.type === 1;
        const isSent: boolean = rawMessage.isSelf === true;
        const threadId: string = rawMessage.threadId || '';
        if (!threadId || threadId === 'undefined') return null;

        // Ảnh JPEG XL (Zalo điện thoại bản mới) → lưu URL bản JPG (đã làm ở EventBroadcaster cho tin realtime;
        // ở đây để phủ cả tin đồng bộ từ điện thoại / các đường lưu trực tiếp).
        const contentRaw = normalizeZaloPhotoContent(rawMessage.data?.content);
        // typeof null === 'object' trong JS - check null/undefined trước khi check typeof object
        const content = contentRaw == null
            ? String(rawMessage.data?.message || '')
            : typeof contentRaw === 'object'
                ? JSON.stringify(contentRaw)
                : String(contentRaw || rawMessage.data?.message || '');

        // Tất cả metadata nằm trong rawMessage.data (không có ở top-level)
        const msgId = rawMessage.data?.msgId || String(Date.now());
        const cliMsgId = rawMessage.data?.cliMsgId || null;
        const uidFrom = rawMessage.data?.uidFrom || ownerZaloId;
        const msgType = rawMessage.data?.msgType || 'text';
        // data.ts là string timestamp ms từ server
        const timestamp = parseInt(rawMessage.data?.ts) || Date.now();

        // Trích dẫn (quote) - lưu nếu có
        let quoteData: string | null = null;
        const rawQuote = rawMessage.data?.quote;
        if (rawQuote && rawQuote.globalMsgId) {
            const quoteImageUrl = toZaloJpgUrl(this.extractImageUrlFromQuote(rawQuote));
            // TQuote không có msgType - chỉ có cliMsgType (number), cần convert sang string
            const quoteMsgType = DatabaseService.clientMsgTypeToMsgType(rawQuote.cliMsgType ?? 0);
            quoteData = JSON.stringify({
                msg: rawQuote.msg ?? '',
                fromD: rawQuote.fromD || '',
                attach: normalizeZaloPhotoContent(rawQuote.attach ?? ''),
                msgType: quoteMsgType,
                msgId: String(rawQuote.globalMsgId),
                cliMsgId: String(rawQuote.cliMsgId ?? ''),
                ownerId: String(rawQuote.ownerId ?? ''),
                imageUrl: quoteImageUrl,
            });
        }

        const rawAttachments = Array.isArray(rawMessage.data?.attachments)
            ? rawMessage.data.attachments
            : [];
        const rawMentions = Array.isArray(rawMessage.data?.mentions)
            ? rawMessage.data.mentions
            : [];
        // Zalo supplies authoritative uid/position/length data for group
        // mentions. Keep it with the message so every bubble type can use
        // the same renderer instead of guessing from visible names.
        const mentionAttachments = rawMentions
            .map((mention: any) => ({
                type: 'zalo_mention',
                offset: Math.max(0, Number(mention?.pos || 0)),
                length: Math.max(0, Number(mention?.len || 0)),
                user_id: String(mention?.uid || ''),
                kind: String(mention?.uid || '') === '-1' || Number(mention?.type) === 1 ? 'all' : 'user',
            }))
            .filter((mention: any) => mention.user_id && mention.length > 0);

        return {
            threadId, isGroup, isSent, content, msgType, timestamp,
            params: [
                msgId,
                cliMsgId,
                ownerZaloId,
                threadId,
                isGroup ? 1 : 0,
                String(uidFrom),
                content,
                msgType,
                timestamp,
                isSent ? 1 : 0,
                JSON.stringify([...rawAttachments, ...mentionAttachments]),
                '{}',
                'received',
                quoteData,
            ],
        };
    }

    /** id tạm của tin Zalo không có id thật: `mb_<cliMsgId>` (đồng bộ từ điện thoại), `cli_<cliMsgId>` (bản nhập cũ). */
    public static isSyntheticZaloMsgId(msgId: unknown): boolean {
        return /^(mb|cli)_/.test(String(msgId || ''));
    }

    /**
     * Cùng một tin Zalo = cùng tài khoản + hội thoại + người gửi + cliMsgId (id phía máy gửi, theo mili-giây). Điện thoại
     * không lưu id thật (GlbMsgId = 0) cho tin mình gửi từ máy khác (Deplao / Zalo PC) → bản đồng bộ mang id tạm `mb_…`
     * và trước đây được thêm thành bản thứ hai (khách báo: đồng bộ tin trong ngày → tin đã gửi bị nhân đôi).
     */
    private findZaloRowByCli(
        ownerZaloId: string, threadId: string, senderId: string, cliMsgId: unknown,
    ): { id: number; msg_id: string; content: string } | undefined {
        const cli = String(cliMsgId || '');
        if (!cli) return undefined;
        // Gọi cho mọi tin Zalo đến → câu lệnh chuẩn bị một lần cho mỗi kết nối DB (db đổi khi xem DB của Boss / workspace).
        // Chỉ lọc (owner, cli_msg_id) để SQLite luôn dùng idx_messages_cli (vài dòng); thêm thread_id vào WHERE thì có lúc
        // nó chọn idx_messages_thread_cursor và quét cả lịch sử hội thoại (đo trên DB thật: hàng chục giây / truy vấn)
        let stmt = zaloCliLookupStatements.get(db!);
        if (!stmt) {
            stmt = db!.prepare(
                `SELECT id, msg_id, thread_id, sender_id, content, COALESCE(channel, 'zalo') AS channel FROM messages
                  WHERE owner_zalo_id = ? AND cli_msg_id = ?`
            );
            zaloCliLookupStatements.set(db!, stmt);
        }
        const rows = stmt.all(ownerZaloId, cli) as Array<{ id: number; msg_id: string; thread_id: string; sender_id: string; content: string; channel: string }>;
        const hit = rows.find(r => r.thread_id === threadId && String(r.sender_id) === senderId && r.channel === 'zalo');
        return hit ? { id: hit.id, msg_id: String(hit.msg_id), content: String(hit.content ?? '') } : undefined;
    }

    /**
     * Zalo đôi khi giao một tin hai lần với id khác nhau — cùng người gửi + cliMsgId + nội dung, chủ yếu tin nhóm (DB thật:
     * 2.723 cặp, 22/10/2026) → true để bỏ bản sau (không lưu, không hiện, không chạy workflow). Chỉ xét tin có id thật;
     * khác nội dung thì vẫn là tin khác.
     */
    public isDuplicateZaloDelivery(ownerZaloId: string, rawMessage: any): boolean {
        if (!this.initialized) return false;
        const row = this.buildZaloMessageRow(ownerZaloId, rawMessage);
        const msgId = String(row?.params[0] || '');
        if (!row || !rawMessage?.data?.msgId || DatabaseService.isSyntheticZaloMsgId(msgId)) return false;
        const existing = this.findZaloRowByCli(ownerZaloId, row.threadId, String(row.params[5] || ''), row.params[1]);
        return !!existing
            && existing.msg_id !== msgId
            && !DatabaseService.isSyntheticZaloMsgId(existing.msg_id)
            && existing.content === row.content;
    }

    /**
     * Tin có id thật trùng một dòng id tạm của cùng tin → đổi dòng đó sang id thật + giờ server (giữ nội dung, media đã
     * tải, cờ đã đọc…). Trả true khi đã xử lý (không chèn dòng mới).
     */
    private upgradeSyntheticZaloRow(
        ownerZaloId: string,
        row: { threadId: string; timestamp: number; params: any[] },
    ): boolean {
        const msgId = String(row.params[0] || '');
        if (!msgId || DatabaseService.isSyntheticZaloMsgId(msgId)) return false;
        const existing = this.findZaloRowByCli(ownerZaloId, row.threadId, String(row.params[5] || ''), row.params[1]);
        if (!existing || existing.msg_id === msgId || !DatabaseService.isSyntheticZaloMsgId(existing.msg_id)) return false;
        try {
            db!.prepare('UPDATE messages SET msg_id = ?, timestamp = ? WHERE id = ?').run(msgId, row.timestamp, existing.id);
        } catch (err: any) {
            // Dòng id thật đã có (UNIQUE) → để INSERT OR IGNORE bỏ qua như cũ
            Logger.warn(`[DatabaseService] Đổi id tạm ${existing.msg_id} → ${msgId} lỗi: ${err?.message}`);
            return false;
        }
        return true;
    }

    /**
     * Lưu hàng loạt tin nhắn lịch sử (đồng bộ từ điện thoại) trong 1 transaction.
     * Map cột giống hệt saveMessage, nhưng KHÔNG tăng unread và chỉ cập nhật preview hội thoại
     * bằng tin mới nhất vừa thêm (updateContactLastMessage tự giữ preview nếu DB đã có tin mới hơn).
     * `isRecalled` (tin đã thu hồi trên điện thoại) → is_recalled = 1.
     */
    public saveHistoryMessagesBulk(ownerZaloId: string, messages: any[]): { inserted: number; ignored: number; threads: string[] } {
        if (!this.initialized || messages.length === 0) return { inserted: 0, ignored: 0, threads: [] };
        const insert = db!.prepare(
            `INSERT OR IGNORE INTO messages
             (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, local_paths, status, quote_data, is_recalled)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        );
        let inserted = 0;
        let ignored = 0;
        const touched = new Set<string>();
        const latest = new Map<string, NonNullable<ReturnType<DatabaseService['buildZaloMessageRow']>>>();

        db!.transaction(() => {
            for (const message of messages) {
                let row: ReturnType<DatabaseService['buildZaloMessageRow']> = null;
                try {
                    row = this.buildZaloMessageRow(ownerZaloId, message);
                } catch (err: any) {
                    Logger.warn(`[DatabaseService] saveHistoryMessagesBulk: bỏ 1 tin lỗi (${err?.message})`);
                }
                if (!row) {
                    ignored++;
                    continue;
                }
                // Đã có tin này (cùng người gửi + cliMsgId) dưới id khác — thường là tin mình gửi: điện thoại chỉ có id tạm
                // mb_… còn DB có id thật từ lúc gửi → giữ dòng đã có (không nhân đôi); dòng cũ id tạm mà nay có id thật → nâng cấp
                const sameMessage = this.findZaloRowByCli(ownerZaloId, row.threadId, String(row.params[5] || ''), row.params[1]);
                if (sameMessage && sameMessage.msg_id !== String(row.params[0])) {
                    this.upgradeSyntheticZaloRow(ownerZaloId, row);
                    ignored++;
                    continue;
                }
                const isRecalled = message.isRecalled === true;
                if (insert.run(...row.params, isRecalled ? 1 : 0).changes === 0) {
                    ignored++;
                    continue;
                }
                inserted++;
                touched.add(row.threadId);
                const ttl = Number(message?.data?.ttl) || 0;
                if (ttl > 0) this.setMessageTtl(ownerZaloId, String(row.params[0]), ttl);
                const prev = latest.get(row.threadId);
                if (!isRecalled && (!prev || row.timestamp >= prev.timestamp)) latest.set(row.threadId, row);
            }
            for (const row of latest.values()) {
                this.updateContactLastMessage(
                    ownerZaloId, row.threadId, row.isGroup ? 1 : 0,
                    row.content, row.msgType, row.timestamp, false,
                );
            }
        })();
        return { inserted, ignored, threads: Array.from(touched) };
    }

    // ─── Ánh xạ ID mobile (plain) ↔ web (noise) — dùng cho đồng bộ từ điện thoại ──

    public getPlainIdMappings(ownerZaloId: string, kind: 'user' | 'group'): Map<string, string> {
        if (!this.initialized) return new Map();
        this.ensurePlainIdMapTable();
        const rows = this.query<{ plain_id: string; noise_id: string }>(
            `SELECT plain_id, noise_id FROM zalo_plain_id_map WHERE owner_zalo_id = ? AND kind = ?`,
            [ownerZaloId, kind]
        );
        return new Map(rows.map(r => [r.plain_id, r.noise_id]));
    }

    public savePlainIdMappings(ownerZaloId: string, kind: 'user' | 'group', pairs: Array<[string, string]>): void {
        if (!this.initialized || pairs.length === 0) return;
        this.ensurePlainIdMapTable();
        const stmt = db!.prepare(
            `INSERT INTO zalo_plain_id_map (owner_zalo_id, kind, plain_id, noise_id, updated_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(owner_zalo_id, kind, plain_id) DO UPDATE SET noise_id = excluded.noise_id, updated_at = excluded.updated_at`
        );
        const now = Date.now();
        db!.transaction(() => {
            for (const [plainId, noiseId] of pairs) stmt.run(ownerZaloId, kind, plainId, noiseId, now);
        })();
    }

    /** Lọc các contact_id chưa có tên thật (display_name rỗng hoặc vẫn là chính ID). */
    public getContactIdsWithoutProfile(ownerZaloId: string, contactIds: string[]): string[] {
        if (!this.initialized || contactIds.length === 0) return [];
        const result: string[] = [];
        for (let i = 0; i < contactIds.length; i += 500) {
            const chunk = contactIds.slice(i, i + 500);
            const rows = this.query<{ contact_id: string }>(
                `SELECT contact_id FROM contacts
                 WHERE owner_zalo_id = ? AND contact_id IN (${chunk.map(() => '?').join(',')})
                   AND (display_name IS NULL OR display_name = '' OR display_name = contact_id)`,
                [ownerZaloId, ...chunk]
            );
            for (const r of rows) result.push(r.contact_id);
        }
        return result;
    }

    /** Mark a message as handled by a specific employee */
    public setMessageHandledByEmployee(ownerZaloId: string, msgId: string, employeeId: string): void {
        if (!this.initialized || !msgId || !employeeId) return;
        try {
            this.run(
                `UPDATE messages SET handled_by_employee = ? WHERE owner_zalo_id = ? AND msg_id = ?`,
                [employeeId, ownerZaloId, msgId]
            );
        } catch (err: any) {
            Logger.warn(`[DatabaseService] setMessageHandledByEmployee error: ${err.message}`);
        }
    }

    /** Mark a message as handled by employee - matches by msg_id OR cli_msg_id (fallback for ID mismatch) */
    public setMessageHandledByEmployeeFlexible(ownerZaloId: string, msgId: string, employeeId: string): void {
        if (!this.initialized || !msgId || !employeeId) return;
        try {
            // OR `(msg_id = ? OR cli_msg_id = ?)` vô hiệu index → quét toàn bộ tin.
            // Tách 2 UPDATE theo index (tương đương: dòng trùng cả 2 id chỉ bị ghi 2 lần
            // cùng một giá trị, vô hại).
            this.run(
                `UPDATE messages SET handled_by_employee = ? WHERE owner_zalo_id = ? AND msg_id = ?`,
                [employeeId, ownerZaloId, msgId]
            );
            this.run(
                `UPDATE messages SET handled_by_employee = ? WHERE owner_zalo_id = ? AND cli_msg_id = ?`,
                [employeeId, ownerZaloId, msgId]
            );
        } catch (err: any) {
            Logger.warn(`[DatabaseService] setMessageHandledByEmployeeFlexible error: ${err.message}`);
        }
    }

    /** Lưu tin nhắn hệ thống (sự kiện nhóm) vào DB */
    public saveSystemMessage(ownerZaloId: string, threadId: string, msgId: string, content: string, timestamp: number, updateMembers?: Array<{id: string; dName?: string; avatar?: string; avatar_25?: string}>): void {
        if (!this.initialized) return;
        try {
            const attachments = updateMembers && updateMembers.length > 0
                ? JSON.stringify(updateMembers.map(m => ({ id: m.id, dName: m.dName || '', avatar: m.avatar || m.avatar_25 || '' })))
                : '[]';
            this.run(
                `INSERT OR IGNORE INTO messages
                 (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, local_paths, status, quote_data)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [msgId, null, ownerZaloId, threadId, 1, 'system', content, 'system', timestamp, 0, attachments, '{}', 'received', null]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveSystemMessage error: ${err.message}`);
        }
    }

    public getMessages(ownerZaloId: string, threadId: string, limit = 50, offset = 0, before?: number, topicId?: string): Message[] {
        if (!this.initialized) return [];
        // Telegram General has UI topic ID "1", but its messages do not carry
        // a forum top_msg_id. Persist them as NULL and expose them through the
        // same topic-aware query contract.
        const isTelegramGeneralTopic = topicId === '1';
        const topicFilter = isTelegramGeneralTopic
            ? ` AND (topic_id IS NULL OR topic_id = '' OR topic_id = '1')`
            : topicId ? ' AND topic_id = ?' : '';
        const topicParams = topicId && !isTelegramGeneralTopic ? [topicId] : [];
        // Một topic: `+msg_id` (cùng giá trị, cùng thứ tự) để SQLite đi idx_messages_topic rồi chỉ xếp phụ các tin trùng mốc.
        // Viết `msg_id DESC` thì nó chọn idx_messages_thread_cursor (khỏi xếp) và lọc topic_id trên cả lịch sử nhóm — DB
        // thật: 250-600 ms mỗi lần mở / cuộn một topic của forum 75k tin, nay ~0,3 ms.
        const orderBy = topicParams.length ? 'timestamp DESC, +msg_id DESC' : 'timestamp DESC, msg_id DESC';
        if (before && before > 0) {
            // Use <= instead of < to handle messages with same timestamp.
            // prependMessages() deduplicates by msg_id, so duplicates are safe.
            const msgs = this.query<Message>(
                `SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ?${topicFilter} AND timestamp <= ? ORDER BY ${orderBy} LIMIT ?`,
                [ownerZaloId, threadId, ...topicParams, before, limit]
            );
            return msgs;
        }
        const msgs = this.query<Message>(
            // Cùng mốc (Telegram chỉ có giây) → id sau = tin sau, như truy vấn theo con trỏ ở trên (cùng chỉ mục)
            `SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ?${topicFilter} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
            [ownerZaloId, threadId, ...topicParams, limit, offset]
        );
        if (msgs.length === 0) {
            Logger.log(`[DB:getMessages] No messages found for owner=${ownerZaloId} thread=${threadId}`);
        }
        return msgs;
    }

    /** Lấy tin nhắn xung quanh 1 timestamp - dùng khi cần scroll đến tin nhắn cũ ngoài trang hiện tại */
    public getMessagesAround(ownerZaloId: string, threadId: string, timestamp: number, limit = 50): Message[] {
        if (!this.initialized) return [];
        const half = Math.floor(limit / 2);
        // Lấy half tin nhắn CŨ hơn hoặc bằng timestamp + half tin nhắn MỚI hơn timestamp
        const older = this.query<Message>(
            'SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?',
            [ownerZaloId, threadId, timestamp, half]
        );
        const newer = this.query<Message>(
            'SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?',
            [ownerZaloId, threadId, timestamp, half]
        );
        // Merge + sort ASC theo timestamp, trả về theo thứ tự cũ → mới
        const combined = [...older, ...newer];
        // Dedup by msg_id (in case timestamp overlap)
        const seen = new Set<string>();
        const deduped = combined.filter(m => {
            if (seen.has(m.msg_id)) return false;
            seen.add(m.msg_id);
            return true;
        });
        deduped.sort((a, b) => a.timestamp - b.timestamp);
        return deduped;
    }

    /** Lấy tất cả file đính kèm trong một thread - dùng cho tab File */
    public getFileMessages(ownerZaloId: string, threadId: string, limit = 50, offset = 0): Message[] {
        if (!this.initialized) return [];
        return this.query<Message>(
            `SELECT msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths, attachments, channel
             FROM messages
             WHERE owner_zalo_id = ? AND thread_id = ?
               AND (
                 msg_type IN ('share.file', 'file', 'share.link')
                 OR (content LIKE '%"title"%' AND content LIKE '%"href"%' AND content LIKE '%"fileExt"%')
                 OR (channel = 'facebook' AND msg_type = 'file' AND attachments IS NOT NULL AND attachments != '[]' AND attachments != '')
               )
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`,
            [ownerZaloId, threadId, limit, offset]
        );
    }
    /**
     * Ảnh/video của một hội thoại, mới → cũ.
     * - Không có `cursor`: trang LIMIT/OFFSET như cũ (panel Ảnh/Video, Public API) — SQL và thứ tự giữ nguyên.
     * - Có `cursor` (bộ sưu tập của trình xem ảnh): trang keyset theo (timestamp, msg_id) trên
     *   idx_messages_thread_cursor — không temp B-tree, chi phí theo trang chứ không theo OFFSET.
     *   Xem mediaMessagesQuery.ts.
     */
    public getMediaMessages(ownerZaloId: string, threadId: string, limit = 50, offset = 0, cursor?: MediaCursor | null): Message[] {
        if (!this.initialized) return [];
        if (cursor && (cursor.beforeTs !== undefined || cursor.afterTs !== undefined)) {
            const page = buildMediaCursorQuery(ownerZaloId, threadId, cursor, limit);
            const rows = this.query<Message>(page.sql, page.params);
            return page.ascending ? rows.reverse() : rows;
        }
        return this.query<Message>(
            `SELECT ${MEDIA_MESSAGE_COLUMNS}
             FROM messages
             WHERE owner_zalo_id = ? AND thread_id = ?
               AND ${MEDIA_MESSAGE_FILTER}
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`,
            [ownerZaloId, threadId, limit, offset]
        );
    }

    /** Lấy tất cả ảnh đã lưu trong folder media cho một tài khoản (tất cả threads) */
    public getAllLocalMediaMessages(ownerZaloId: string): Message[] {
        if (!this.initialized) return [];
        return this.query<Message>(
            `SELECT msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths
             FROM messages
             WHERE owner_zalo_id = ?
               AND local_paths IS NOT NULL AND local_paths != '{}' AND local_paths != '' AND local_paths != 'null'
             ORDER BY timestamp DESC
             LIMIT 500`,
            [ownerZaloId]
        );
    }

    public searchMessages(ownerZaloId: string, query: string): Message[] {
        if (!this.initialized) return [];
        const text = String(query ?? '').trim();
        if (!text) return [];

        // FTS5 theo tiền tố, an toàn với ký tự đặc biệt, thử cả d / đ (shared/chat/messageSearch). Chỉ lấy
        // MESSAGE_SEARCH_FTS_CANDIDATES dòng khớp mới nhất theo rowid rồi mới xếp theo thời gian: xếp MỌI dòng khớp
        // của từ phổ biến ("anh") mất ~0,6 s, chặn tiến trình chính.
        const ftsQuery = buildMessageFtsQuery(text);
        if (ftsQuery && this.hasMessagesFts()) {
            try {
                const rows = this.query<Message>(
                    `SELECT m.* FROM messages m
                     WHERE m.rowid IN (
                         SELECT rowid FROM messages_fts
                         WHERE messages_fts MATCH ? AND owner_zalo_id = ?
                         ORDER BY rowid DESC LIMIT ${MESSAGE_SEARCH_FTS_CANDIDATES}
                     )
                     ORDER BY m.timestamp DESC LIMIT ${MESSAGE_SEARCH_LIMIT}`,
                    [ftsQuery, ownerZaloId]
                );
                if (rows.length > 0) return rows;
            } catch (err: any) {
                Logger.warn(`[DatabaseService] searchMessages: FTS lỗi (${err?.message}) — dùng LIKE trên tin gần đây`);
            }
        }

        // Không có FTS / FTS không khớp (khớp giữa từ như "freeship", emoji…): LIKE chỉ trên các tin gần nhất của
        // tài khoản. Trước đây LIKE '%…%' quét cả bảng — 1,3 triệu tin ≈ 30 s đứng cả app mỗi lần gõ sai / từ hiếm.
        return this.query<Message>(
            `SELECT * FROM (
                 SELECT * FROM messages WHERE owner_zalo_id = ?
                 ORDER BY timestamp DESC LIMIT ${MESSAGE_SEARCH_RECENT_SCAN}
             ) WHERE content LIKE ? ESCAPE '\\'
             ORDER BY timestamp DESC LIMIT ${MESSAGE_SEARCH_LIMIT}`,
            [ownerZaloId, `%${escapeLikePattern(text)}%`]
        );
    }

    /** Bảng messages_fts đã có (migrateFTS5 lúc mở DB). Chỉ nhớ khi đã thấy — chưa có thì lần sau kiểm lại. */
    private messagesFtsReady = false;
    private hasMessagesFts(): boolean {
        if (this.messagesFtsReady) return true;
        this.messagesFtsReady = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'`).length > 0;
        return this.messagesFtsReady;
    }

    // ─── Contact Operations ───────────────────────────────────────────────

    public saveContact(contact: Omit<Contact, 'id'>): void {
        if (!this.initialized) return;
        const normalizedPhone = this.normalizeVietnamPhone(contact.phone || '');
        this.run(
            `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count, last_message, last_message_time)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
               display_name=excluded.display_name,
               avatar_url=excluded.avatar_url,
               phone=excluded.phone,
               is_friend=excluded.is_friend,
               contact_type=excluded.contact_type`,
            [contact.owner_zalo_id, contact.contact_id, contact.display_name, contact.avatar_url, normalizedPhone, contact.is_friend, contact.contact_type, contact.unread_count || 0, contact.last_message || '', contact.last_message_time || 0]
        );
    }

    public getContacts(ownerZaloId: string): Contact[] {
        if (!this.initialized) return [];
        // is_replied như getContactsFiltered: các nơi nạp lại cả danh bạ (đồng bộ, khởi động) không làm mất trạng thái
        return this.query<Contact>(
            `SELECT contacts.*, ${this.replyStateColumnSql()} AS is_replied FROM contacts WHERE owner_zalo_id = ? ORDER BY last_message_time DESC`,
            [ownerZaloId]
        );
    }

    /**
     * Cột SQL is_replied (đã / chưa trả lời) cho bảng `contacts` của kết nối đang dùng — shared/chat/replyState. DB chưa có cột
     * reply_marked_at (DB phụ cũ) vẫn đọc được, chỉ không tính đánh dấu tay.
     */
    public replyStateColumnSql(): string {
        return contactReplyStateSql('contacts', this.hasColumn('contacts', 'reply_marked_at'));
    }

    /** Cột có trong bảng của DB đang dùng không — nhớ theo từng kết nối (DB chính và DB phụ của withDbPath khác nhau). */
    private static readonly knownColumns = new WeakMap<object, Map<string, boolean>>();

    private hasColumn(table: string, column: string): boolean {
        if (!db) return false;
        let columns = DatabaseService.knownColumns.get(db);
        if (!columns) {
            columns = new Map();
            DatabaseService.knownColumns.set(db, columns);
        }
        const key = `${table}.${column}`;
        let exists = columns.get(key);
        if (exists === undefined) {
            exists = this.query<{ name: string }>(`PRAGMA table_info(${table})`).some((row) => row.name === column);
            columns.set(key, exists);
        }
        return exists;
    }

    /**
     * Đánh dấu đã trả lời / bỏ đánh dấu (không gửi tin) — hàng loạt hoặc một hội thoại. Đánh dấu: reply_marked_at = thời
     * điểm tin mới nhất của hội thoại lúc này (chỉ tiến lên) → tin người kia tới SAU đó lại thành "chưa trả lời". Bỏ đánh
     * dấu: 0 (trạng thái lại theo tin cuối). Trả trạng thái mới (is_replied) của từng hội thoại.
     */
    public markConversationsReplied(
        ownerZaloId: string,
        contactIds: string[],
        replied: boolean,
    ): Array<{ contact_id: string; is_replied: number | null; reply_marked_at: number }> {
        if (!this.initialized || !ownerZaloId || !this.hasColumn('contacts', 'reply_marked_at')) return [];
        const ids = [...new Set((contactIds || []).map(String).filter(Boolean))];
        const results: Array<{ contact_id: string; is_replied: number | null; reply_marked_at: number }> = [];
        const now = Date.now();
        for (let i = 0; i < ids.length; i += 400) {
            const chunk = ids.slice(i, i + 400);
            const marks = chunk.map(() => '?').join(', ');
            db!.transaction(() => {
                if (replied) {
                    this.run(
                        `UPDATE contacts SET reply_marked_at = MAX(COALESCE(reply_marked_at, 0), COALESCE(
                            (SELECT MAX(m.timestamp) FROM messages m
                              WHERE m.owner_zalo_id = contacts.owner_zalo_id AND m.thread_id = contacts.contact_id),
                            NULLIF(${CONTACT_LAST_MS_SQL}, 0), ?))
                         WHERE owner_zalo_id = ? AND contact_id IN (${marks})`,
                        [now, ownerZaloId, ...chunk],
                    );
                } else {
                    this.run(`UPDATE contacts SET reply_marked_at = 0 WHERE owner_zalo_id = ? AND contact_id IN (${marks})`, [ownerZaloId, ...chunk]);
                }
            })();
            results.push(...this.query<any>(
                `SELECT contact_id, ${this.replyStateColumnSql()} AS is_replied, COALESCE(reply_marked_at, 0) AS reply_marked_at
                 FROM contacts WHERE owner_zalo_id = ? AND contact_id IN (${marks})`,
                [ownerZaloId, ...chunk],
            ));
        }
        return results;
    }

    /**
     * Ô chọn liên hệ của workflow: tìm (không dấu) + lọc loại + phân trang ngay ở main process,
     * chỉ trả 1 trang qua IPC thay vì toàn bộ danh bạ (vài nghìn dòng / tài khoản).
     */
    public searchContactsForPicker(ownerZaloId: string, opts: PickerSearchOptions = {}): PickerSearchResult {
        if (!this.initialized || !ownerZaloId) return { items: [], total: 0, counts: { all: 0, user: 0, group: 0 } };
        const rows = this.query<PickerContactRow>(
            `SELECT contact_id, display_name, alias, avatar_url, phone, contact_type, is_friend, last_message_time
             FROM contacts WHERE owner_zalo_id = ?`,
            [ownerZaloId]
        );
        return searchPickerContacts(rows, opts);
    }

    /** getContacts với filter channel, search, others — filter ở DB level cho nhanh */
    public getContactsFiltered(ownerZaloId: string, opts?: {
        channel?: string;
        search?: string;
        othersOnly?: boolean;
        excludeOthers?: boolean;
        unreadOnly?: boolean;
        /** Lọc theo loại hội thoại (Public API v1 dùng để liệt kê nhóm). */
        contactType?: 'user' | 'group';
        /** Chỉ các hội thoại này (vd. hội thoại ghim nằm ở trang sau, chưa tải) — tối đa 200. */
        contactIds?: string[];
        /** Hội thoại 1:1 mà tin thật mới nhất là của người kia (bộ lọc "Chưa trả lời"). */
        unrepliedOnly?: boolean;
        /** Tin cuối trong khoảng thời gian (ms, đã tính theo ngày giờ máy ở renderer). */
        fromTs?: number;
        toTs?: number;
        limit?: number;
        offset?: number;
    }): Contact[] {
        if (!this.initialized) return [];
        const conditions: string[] = ['owner_zalo_id = ?'];
        const params: any[] = [ownerZaloId];

        if (opts?.channel && opts.channel !== 'all') {
            conditions.push('channel = ?');
            params.push(opts.channel);
        }
        if (opts?.search) {
            const q = `%${opts.search.toLowerCase()}%`;
            conditions.push("(LOWER(display_name) LIKE ? OR LOWER(alias) LIKE ? OR contact_id LIKE ? OR phone LIKE ?)");
            params.push(q, q, q, q);
        }
        if (opts?.othersOnly) {
            conditions.push('is_in_others = 1');
        }
        if (opts?.excludeOthers) {
            conditions.push('is_in_others = 0');
        }
        if (opts?.unreadOnly) {
            conditions.push('unread_count > 0');
        }
        if (opts?.contactType === 'group') {
            conditions.push("contact_type = 'group'");
        } else if (opts?.contactType === 'user') {
            conditions.push("(contact_type IS NULL OR contact_type != 'group')");
        }
        if (Array.isArray(opts?.contactIds)) {
            const ids = [...new Set(opts!.contactIds.map(String).filter(Boolean))].slice(0, 200);
            if (ids.length === 0) return [];
            conditions.push(`contact_id IN (${ids.map(() => '?').join(', ')})`);
            params.push(...ids);
        }
        const fromTs = Number(opts?.fromTs);
        if (Number.isFinite(fromTs) && fromTs > 0) {
            conditions.push(`${CONTACT_LAST_MS_SQL} >= ?`);
            params.push(Math.floor(fromTs));
        }
        const toTs = Number(opts?.toTs);
        if (Number.isFinite(toTs) && toTs > 0) {
            conditions.push(`${CONTACT_LAST_MS_SQL} <= ?`);
            params.push(Math.floor(toTs));
        }
        if (opts?.unrepliedOnly) {
            conditions.push("(contact_type IS NULL OR contact_type != 'group')");
        }

        const where = conditions.join(' AND ');
        const requestedLimit = Number(opts?.limit);
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
            ? Math.min(Math.floor(requestedLimit), 501)
            : 0;
        const requestedOffset = Number(opts?.offset);
        const offset = Number.isFinite(requestedOffset) && requestedOffset > 0
            ? Math.floor(requestedOffset)
            : 0;
        const pagination = limit > 0 ? ' LIMIT ? OFFSET ?' : '';
        if (limit > 0) params.push(limit, offset);
        // is_replied: đã trả lời / chưa trả lời theo tin thật mới nhất (shared/chat/replyState) — tính ở đây để danh sách đúng
        // ngay khi mở app (trước đây chỉ có trong bộ nhớ, mất sau khi khởi động lại)
        const select = `SELECT contacts.*, ${this.replyStateColumnSql()} AS is_replied FROM contacts WHERE ${where}`;
        return this.query<Contact>(
            opts?.unrepliedOnly
                ? `SELECT * FROM (${select}) WHERE is_replied = 0 ORDER BY last_message_time DESC${pagination}`
                : `${select} ORDER BY last_message_time DESC${pagination}`,
            params
        );
    }

    /**
     * Tìm contact trong DB theo số điện thoại (normalized).
     * So khớp cả phone đã lưu (normalized) và raw phone từ user nhập.
     */
    public searchContactByPhone(ownerZaloId: string, phone: string): Contact | null {
        if (!this.initialized || !phone) return null;
        const normalized = this.normalizeVietnamPhone(phone);
        if (!normalized) return null;
        // So khớp chính xác hoặc so khớp phần cuối (cho trường hợp số nhập thiếu đầu)
        return this.queryOne<Contact>(
            `SELECT * FROM contacts
             WHERE owner_zalo_id = ?
               AND (phone = ? OR phone LIKE ?)
             LIMIT 1`,
            [ownerZaloId, normalized, `%${normalized.slice(-7)}`]
        ) || null;
    }

    /** Update one or more flag columns (is_muted, mute_until, is_in_others, has_mention) for a contact row */
    public setContactFlags(ownerZaloId: string, contactId: string, flags: { is_muted?: number; mute_until?: number; is_in_others?: number; has_mention?: number }): void {
        if (!this.initialized || !contactId) return;
        const sets: string[] = [];
        const vals: any[] = [];
        if (flags.is_muted !== undefined)    { sets.push('is_muted=?');    vals.push(flags.is_muted); }
        if (flags.mute_until !== undefined)  { sets.push('mute_until=?');  vals.push(flags.mute_until); }
        if (flags.is_in_others !== undefined){ sets.push('is_in_others=?');vals.push(flags.is_in_others); }
        if (flags.has_mention !== undefined) { sets.push('has_mention=?'); vals.push(flags.has_mention); }
        if (sets.length === 0) return;
        vals.push(ownerZaloId, contactId);
        this.run(`UPDATE contacts SET ${sets.join(', ')} WHERE owner_zalo_id=? AND contact_id=?`, vals);
    }

    /** Tự xoá tin nhắn trên Zalo (ms, ZL-05) của một hội thoại; true khi giá trị thật sự đổi. */
    public setContactAutoDeleteTtl(ownerZaloId: string, contactId: string, ttl: number): boolean {
        if (!this.initialized || !contactId) return false;
        const next = Math.max(0, Number(ttl) || 0);
        const row = this.queryOne<{ zalo_auto_delete_ttl: number | null }>(
            'SELECT zalo_auto_delete_ttl FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId],
        );
        if (!row || (Number(row.zalo_auto_delete_ttl) || 0) === next) return false;
        this.run('UPDATE contacts SET zalo_auto_delete_ttl = ? WHERE owner_zalo_id = ? AND contact_id = ?', [next, ownerZaloId, contactId]);
        return true;
    }

    /**
     * Thay cả danh sách hội thoại đang bật tự xoá của một tài khoản (getAutoDeleteChat): hội thoại không còn trong danh
     * sách về 0. Trả các hội thoại có giá trị đổi (để báo giao diện).
     */
    public replaceContactAutoDeleteTtls(ownerZaloId: string, ttls: ReadonlyMap<string, number>): Array<{ contactId: string; ttl: number }> {
        if (!this.initialized) return [];
        const changed: Array<{ contactId: string; ttl: number }> = [];
        const enabled = this.query<{ contact_id: string }>(
            'SELECT contact_id FROM contacts WHERE owner_zalo_id = ? AND zalo_auto_delete_ttl > 0', [ownerZaloId],
        );
        db!.transaction(() => {
            for (const row of enabled) {
                if (ttls.has(row.contact_id)) continue;
                this.run('UPDATE contacts SET zalo_auto_delete_ttl = 0 WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, row.contact_id]);
                changed.push({ contactId: row.contact_id, ttl: 0 });
            }
            for (const [contactId, ttl] of ttls) {
                if (this.setContactAutoDeleteTtl(ownerZaloId, contactId, ttl)) changed.push({ contactId, ttl });
            }
        })();
        return changed;
    }

    /** Thời gian tự xoá (ms) Zalo gắn cho một tin — chỉ để hiển thị; Deplao không xoá tin theo TTL. */
    public setMessageTtl(ownerZaloId: string, msgId: string, ttl: number): void {
        if (!this.initialized || !msgId || !(ttl > 0) || !this.hasColumn('messages', 'ttl')) return;
        this.run('UPDATE messages SET ttl = ? WHERE owner_zalo_id = ? AND msg_id = ?', [ttl, ownerZaloId, msgId]);
    }

    /** Tự xoá (ms) đang bật của một hội thoại Zalo; 0 = tắt / chưa biết. Tin gửi từ Deplao mang ttl này (FR-ZL05.7). */
    public getContactAutoDeleteTtl(ownerZaloId: string, contactId: string): number {
        if (!this.initialized || !contactId) return 0;
        const row = this.queryOne<{ zalo_auto_delete_ttl: number | null }>(
            'SELECT zalo_auto_delete_ttl FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId],
        );
        return Math.max(0, Number(row?.zalo_auto_delete_ttl) || 0);
    }

    /**
     * Các tin trong `msgIds` (msg_id hoặc cli_msg_id) đã quá hạn tự xoá trên Zalo: sự kiện xoá / thu hồi của chúng là Zalo
     * dọn tin hết hạn → Deplao giữ nguyên nội dung, không đánh dấu "đã thu hồi" (FR-ZL05.6).
     */
    public zaloTtlExpiredMessageIds(
        ownerZaloId: string, msgIds: string[], threadId?: string, now: number = Date.now(), graceMs: number = ZALO_TTL_EXPIRY_GRACE_MS,
    ): Set<string> {
        const expired = new Set<string>();
        if (!this.initialized || msgIds.length === 0 || !this.hasColumn('messages', 'ttl')) return expired;
        for (const raw of msgIds) {
            const msgId = String(raw || '');
            if (!msgId) continue;
            const scope = this.messageIdScope(ownerZaloId, msgId, threadId);
            // msg_id rồi cli_msg_id (2 lần tra index): OR làm SQLite quét mọi tin của tài khoản
            const row = this.queryOne<{ timestamp: number; ttl: number }>(
                `SELECT timestamp, ttl FROM messages WHERE owner_zalo_id = ? AND msg_id = ? AND ttl > 0${scope.sql} LIMIT 1`,
                [ownerZaloId, msgId, ...scope.params],
            ) ?? this.queryOne<{ timestamp: number; ttl: number }>(
                `SELECT timestamp, ttl FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND ttl > 0${scope.sql} LIMIT 1`,
                [ownerZaloId, msgId, ...scope.params],
            );
            if (row && isZaloTtlExpired(row.timestamp, row.ttl, now, graceMs)) expired.add(msgId);
        }
        return expired;
    }

    /** Hội thoại ẩn bằng PIN trên Zalo (ZL-03); true khi giá trị thật sự đổi. */
    public setContactHidden(ownerZaloId: string, contactId: string, hidden: boolean): boolean {
        if (!this.initialized || !contactId || !this.hasColumn('contacts', 'zalo_hidden')) return false;
        const next = hidden ? 1 : 0;
        const row = this.queryOne<{ zalo_hidden: number | null }>(
            'SELECT zalo_hidden FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId],
        );
        if (!row || (Number(row.zalo_hidden) || 0) === next) return false;
        this.run('UPDATE contacts SET zalo_hidden = ? WHERE owner_zalo_id = ? AND contact_id = ?', [next, ownerZaloId, contactId]);
        return true;
    }

    /** Thay cả danh sách hội thoại ẩn của một tài khoản (getHiddenConversations); trả các hội thoại có giá trị đổi. */
    public replaceContactHidden(ownerZaloId: string, hiddenIds: ReadonlySet<string>): Array<{ contactId: string; hidden: boolean }> {
        if (!this.initialized || !this.hasColumn('contacts', 'zalo_hidden')) return [];
        const changed: Array<{ contactId: string; hidden: boolean }> = [];
        const current = this.query<{ contact_id: string }>(
            'SELECT contact_id FROM contacts WHERE owner_zalo_id = ? AND zalo_hidden = 1', [ownerZaloId],
        );
        db!.transaction(() => {
            for (const row of current) {
                if (hiddenIds.has(row.contact_id)) continue;
                this.run('UPDATE contacts SET zalo_hidden = 0 WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, row.contact_id]);
                changed.push({ contactId: row.contact_id, hidden: false });
            }
            for (const contactId of hiddenIds) {
                if (this.setContactHidden(ownerZaloId, contactId, true)) changed.push({ contactId, hidden: true });
            }
        })();
        return changed;
    }

    /** Get flag columns for a specific contact */
    public getContactFlags(ownerZaloId: string, contactId: string): { is_muted: number; mute_until: number; is_in_others: number } | null {
        if (!this.initialized) return null;
        return this.queryOne<any>(
            'SELECT is_muted, mute_until, is_in_others FROM contacts WHERE owner_zalo_id=? AND contact_id=?',
            [ownerZaloId, contactId]
        ) || null;
    }

    /** Get all contacts that have flags set (for bulk load on startup) */
    public getContactsWithFlags(ownerZaloId: string): { contact_id: string; is_muted: number; mute_until: number; is_in_others: number; telegram_archived: number; zalo_hidden?: number }[] {
        if (!this.initialized) return [];
        // zalo_hidden: hội thoại ẩn bằng PIN (ZL-03) — DB chưa có cột (bản thử nghiệm) thì bỏ qua
        const hidden = this.hasColumn('contacts', 'zalo_hidden');
        return this.query<any>(
            `SELECT contact_id, is_muted, mute_until, is_in_others, telegram_archived${hidden ? ', zalo_hidden' : ''} FROM contacts
             WHERE owner_zalo_id=? AND (is_muted=1 OR mute_until>0 OR is_in_others=1 OR telegram_archived=1${hidden ? ' OR zalo_hidden=1' : ''})`,
            [ownerZaloId]
        );
    }

    /**
     * Lưu biệt danh (alias) cho một contact.
     * alias='' nghĩa là xóa biệt danh.
     * Không bao giờ overwrite display_name - alias là field riêng biệt.
     */
    public setContactAlias(ownerZaloId: string, contactId: string, alias: string): void {
        if (!this.initialized || !contactId) return;
        this.run(
            `UPDATE contacts SET alias=? WHERE owner_zalo_id=? AND contact_id=?`,
            [alias || '', ownerZaloId, contactId]
        );
    }

    /**
     * Cập nhật display_name và avatar_url của contact vào DB.
     * Được gọi khi có thông tin tên/ảnh (từ senderInfo trong message event hoặc getUserInfo API).
     */
    public updateContactProfile(ownerZaloId: string, contactId: string, displayName: string, avatarUrl: string, phone: string = '', contactType: string = '', gender?: number | null, birthday?: string | null, isBot?: number | null, manualDetails: boolean = false): void {
        if (!this.initialized || !contactId || contactId === 'undefined') return;
        try {
            const normalizedPhone = this.normalizeVietnamPhone(phone || '');
            this.run(
                `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count, channel)
                 VALUES (?,?,?,?,?,0,?,0, COALESCE((SELECT channel FROM accounts WHERE zalo_id = ?), 'zalo'))
                 ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                   display_name=CASE WHEN ?!='' THEN ? ELSE contacts.display_name END,
                   avatar_url=CASE WHEN ?!='' THEN ? ELSE contacts.avatar_url END,
                   phone=CASE WHEN ?!='' THEN ? ELSE contacts.phone END,
                   contact_type=CASE WHEN ?!='' THEN ? ELSE contacts.contact_type END`,
                [
                    ownerZaloId, contactId,
                    displayName || contactId, avatarUrl || '', normalizedPhone,
                    contactType || 'user',
                    // Dòng mới mang kênh của tài khoản sở hữu: mặc định của cột là 'zalo' nên người Telegram (hồ sơ thành viên
                    // nhóm, "Nhắn tin" từ hồ sơ) từng thành liên hệ Zalo của tài khoản Telegram
                    ownerZaloId,
                    // ON CONFLICT params: display_name
                    displayName, displayName,
                    // avatar_url
                    avatarUrl, avatarUrl,
                    // phone
                    normalizedPhone, normalizedPhone,
                    // contact_type
                    contactType, contactType,
                ]
            );

            // Các lần đồng bộ chỉ bổ sung dữ liệu có sẵn; thao tác thủ công phải
            // ghi chính xác cả giá trị rỗng để người dùng có thể xoá một trường.
            if (manualDetails) {
                this.run(
                    `UPDATE contacts SET phone=?, gender=?, birthday=? WHERE owner_zalo_id=? AND contact_id=?`,
                    [normalizedPhone, gender ?? null, birthday?.trim() || null, ownerZaloId, contactId]
                );
            } else if (gender !== undefined && gender !== null) {
                this.run(
                    `UPDATE contacts SET gender=? WHERE owner_zalo_id=? AND contact_id=?`,
                    [gender, ownerZaloId, contactId]
                );
            }
            if (!manualDetails && birthday !== undefined && birthday !== null && birthday !== '') {
                this.run(
                    `UPDATE contacts SET birthday=? WHERE owner_zalo_id=? AND contact_id=?`,
                    [birthday, ownerZaloId, contactId]
                );
            }
            if (isBot !== undefined && isBot !== null) {
                this.run(
                    `UPDATE contacts SET is_cov_bot=? WHERE owner_zalo_id=? AND contact_id=?`,
                    [isBot, ownerZaloId, contactId]
                );
            }
        } catch (err: any) {
            Logger.error(`[DatabaseService] updateContactProfile error: ${err.message}`);
        }
    }

    /**
     * Ghi kết quả làm mới hàng loạt (zalo:getUserInfo) vào DB theo UID.
     * - Chỉ UPDATE dòng đã có (contacts + friends), không tạo dòng mới.
     * - Tên chỉ ghi khi API trả về tên khác rỗng; avatar chỉ ghi khi có URL.
     * - Mọi UID đã hỏi API (`checkedIds`, kể cả không có profile) đều được đóng dấu
     *   `info_refreshed_at` để không hỏi lại liên tục những tài khoản không còn tồn tại.
     * @returns số dòng contacts được cập nhật tên/avatar
     */
    public applyContactInfoRefresh(
        ownerZaloId: string,
        profiles: Array<{ contactId: string; displayName?: string; avatarUrl?: string }>,
        checkedIds: string[] = [],
        refreshedAt: number = Date.now(),
    ): number {
        if (!this.initialized || !ownerZaloId) return 0;
        let updated = 0;
        try {
            this.transaction(() => {
                const updateContact = db!.prepare(
                    `UPDATE contacts SET
                        display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
                        avatar_url = CASE WHEN ? != '' THEN ? ELSE avatar_url END,
                        info_refreshed_at = ?
                     WHERE owner_zalo_id = ? AND contact_id = ?`
                );
                const updateFriend = db!.prepare(
                    `UPDATE friends SET
                        display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
                        avatar = CASE WHEN ? != '' THEN ? ELSE avatar END
                     WHERE owner_zalo_id = ? AND user_id = ?`
                );
                const stamp = db!.prepare(
                    `UPDATE contacts SET info_refreshed_at = ?
                     WHERE owner_zalo_id = ? AND contact_id = ? AND COALESCE(info_refreshed_at, 0) < ?`
                );
                for (const p of profiles) {
                    const contactId = String(p?.contactId || '').trim();
                    if (!contactId || contactId === 'undefined') continue;
                    const name = String(p.displayName || '').trim();
                    const avatar = String(p.avatarUrl || '').trim();
                    if (!name && !avatar) continue;
                    const res = updateContact.run(name, name, avatar, avatar, refreshedAt, ownerZaloId, contactId);
                    if (Number(res.changes) > 0) updated++;
                    updateFriend.run(name, name, avatar, avatar, ownerZaloId, contactId);
                }
                for (const id of checkedIds) {
                    const contactId = String(id || '').trim();
                    if (contactId) stamp.run(refreshedAt, ownerZaloId, contactId, refreshedAt);
                }
            });
        } catch (err: any) {
            Logger.error(`[DatabaseService] applyContactInfoRefresh error: ${err.message}`);
        }
        return updated;
    }

    /** Chuyển content thô (JSON) thành chuỗi hiển thị cho last_message */
    private formatLastMessageContent(content: string, msgType: string): string {
        const mt = (msgType || '').toLowerCase();

        // ── Explicit type checks (fast path, no JSON parse needed) ──────────
        if (mt.includes('call')) return '📞 Cuộc gọi';
        if (mt === 'chat.voice' || mt.includes('voice') || mt.includes('audio')) return '🎙 Tin nhắn thoại';
        if (mt === 'chat.sticker' || mt.includes('sticker')) return '🎭 Nhãn dán';
        if (mt.includes('gif')) return '🎬 GIF';
        if (mt.includes('video')) return '🎥 Video';
        if (mt === 'photo' || mt === 'image' || mt === 'chat.photo' || mt.includes('photo')) return '📸 Hình ảnh';
        if (mt === 'share.file' || mt === 'file') {
            try {
                const p = JSON.parse(content);
                return p?.title ? `📂 ${p.title}` : '📂 File đính kèm';
            } catch { return '📂 File đính kèm'; }
        }

        // ── System card (chat.ecard): nhắc hẹn, thông báo nhóm ────────────────
        if (mt === 'chat.ecard') {
            try {
                const p = JSON.parse(content);
                if (p?.title) return `🔔 ${p.title}`;
            } catch {}
            return '🔔 Thông báo';
        }

        // ── Link types (chat.recommended, chat.link, share.link) ───────────────
        if (mt === 'chat.recommended' || mt === 'chat.recommend' || mt === 'chat.link' || mt === 'share.link') {
            try {
                const p = JSON.parse(content);
                const act = String(p?.action || '');
                // Call actions inside chat.recommended
                if (act === 'recommened.misscall') return '📵 Cuộc gọi nhỡ';
                if (act === 'recommened.calltime') {
                    let prm: any = {};
                    try { prm = typeof p.params === 'string' ? JSON.parse(p.params) : (p.params || {}); } catch {}
                    const secs = prm.duration || 0;
                    if (secs > 0) { const m = Math.floor(secs / 60), s = secs % 60; return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`; }
                    return '📞 Cuộc gọi';
                }
                if (p?.title) return `🔗 ${p.title}`;
            } catch {}
            return '🔗 Link';
        }

        // ── Bank card (chat.webcontent) ─────────────────────────────────────────
        if (mt === 'chat.webcontent') {
            try {
                const p = JSON.parse(content);
                if (p?.action === 'zinstant.bankcard') return '🏦 Tài khoản ngân hàng';
                if (p?.title) return p.title;
            } catch {}
        }
        // ── Bản tin / thông báo của Official Account (zinstant) ─────────────────
        if (mt === 'chat.webcontent' || mt === 'chat.webcontent.v2') {
            const zinstant = zinstantPreviewText(content, mt);
            if (zinstant) return zinstant;
        }

        // ── Bản tin Official Account (chat.list.action): content là mảng bài viết ──
        if (mt === 'chat.list.action') {
            try {
                const p = JSON.parse(content);
                const items = Array.isArray(p) ? p : [p];
                const first = items.find((it: any) => it && typeof it === 'object' && String(it.title || '').trim());
                if (first) return `📰 ${String(first.title).trim()}`;
            } catch {}
            return '📰 Bản tin';
        }

        // ── Poll ───────────────────────────────────────────────────────────────
        if (mt === 'group.poll') return '📊 Bình chọn';

        // ── Todo ──────────────────────────────────────────────────────────────
        if (mt === 'chat.todo') return '📝 Công việc';

        // ── Location ──────────────────────────────────────────────────────────
        if (mt === 'chat.location.new') {
            try {
                const p = JSON.parse(content);
                if (p?.description) return `📍 ${p.description}`;
                const params = typeof p?.params === 'string' ? JSON.parse(p.params) : (p?.params || {});
                if (params?.latitude && params?.longitude) return `📍 ${params.latitude.slice(0, 8)}, ${params.longitude.slice(0, 8)}`;
            } catch {}
            return '📍 [Vị trí]';
        }

        // ── JSON content: parse and detect type from fields ──────────────────
        try {
            const p = JSON.parse(content);
            if (p && typeof p === 'object') {
                // chat.recommended call actions (action field inside content)
                const action = String(p.action || '');
                if (action === 'recommened.misscall') return '📵 Cuộc gọi nhỡ';
                if (action === 'recommened.calltime') {
                    let params: any = {};
                    try { params = typeof p.params === 'string' ? JSON.parse(p.params) : (p.params || {}); } catch {}
                    const secs = params.duration || 0;
                    if (secs > 0) {
                        const m = Math.floor(secs / 60), s = secs % 60;
                        return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`;
                    }
                    return '📞 Cuộc gọi';
                }
                // Legacy call object
                if (p.call_id || p.callId || p.callType !== undefined) {
                    const missed = p.missed || p.status === 2;
                    const secs = p.duration || p.call_duration;
                    if (missed) return '📵 Cuộc gọi nhỡ';
                    if (secs) { const m = Math.floor(secs / 60), s = secs % 60; return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`; }
                    return '📞 Cuộc gọi';
                }
                // Sticker detected from content
                if (p.sticker_id || p.stickerId) return '🎭 Nhãn dán';
                // Link action (recommened.link)
                if (action === 'recommened.link' || action === 'recommended.link') {
                    if (p.title) return `🔗 ${p.title}`;
                    return '🔗 Link';
                }
                // Bank card action
                if (action === 'zinstant.bankcard') return '🏦 Tài khoản ngân hàng';
                // parse params (may be string)
                let params: any = p.params;
                if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
                // File: has title + file-specific fields (fileSize, fileExt, fileUrl, normalUrl)
                if (p.title && (params?.fileSize || params?.fileExt || params?.fileUrl || p.normalUrl || p.fileUrl)) return `📂 ${p.title}`;
                // Link heuristic: title + href without image params → link, not image
                if (p.title && p.href && !params?.rawUrl && !params?.hd) return `🔗 ${p.title}`;
                // Image heuristic: has rawUrl/hd, or href/thumb without title
                if (params?.rawUrl || params?.hd) return '🖼 Hình ảnh';
                if ((p.href || p.thumb) && !p.title) return '🖼 Hình ảnh';
                // Plain text stored as JSON string
                if (typeof p === 'string') return p.length > 100 ? p.substring(0, 100) + '...' : p;
                // title without file markers → show title as text (e.g. reminder, link preview)
                if (p.title && typeof p.title === 'string') return p.title;
                if (p.msg && typeof p.msg === 'string') return p.msg;
                if (p.content && typeof p.content === 'string') return p.content;
                return '[Đính kèm]';
            }
            if (typeof p === 'string') return p.length > 100 ? p.substring(0, 100) + '...' : p;
        } catch {}
        return content.length > 100 ? content.substring(0, 100) + '...' : content;
    }

    /**
     * Old Telegram records used a media caption as the conversation preview.
     * Rebuild only rows whose latest message is media, while keeping any group
     * sender prefix already present in the row.
     */
    public repairTelegramLastMessagePreviews(ownerZaloId: string, channel?: 'telegram_user' | 'telegram_bot'): number {
        if (!this.initialized || !ownerZaloId) return 0;
        const channels = channel ? [channel] : ['telegram_user', 'telegram_bot'];
        const mediaTypes = [
            'photo', 'video', 'video_note', 'audio', 'voice', 'sticker', 'file', 'document',
            'telegram.contact', 'telegram.location', 'telegram.venue', 'telegram.poll',
            'telegram.dice', 'telegram.game', 'telegram.invoice', 'telegram.story',
            'telegram.giveaway', 'telegram.webpage',
        ];
        let repaired = 0;
        try {
            for (const currentChannel of channels) {
                const rows = this.query<any>(`
                    SELECT c.contact_id, c.last_message, m.content, m.msg_type
                    FROM contacts c
                    JOIN messages m ON m.rowid = (
                        SELECT m2.rowid
                        FROM messages m2
                        WHERE m2.owner_zalo_id = c.owner_zalo_id
                          AND m2.thread_id = c.contact_id
                          AND m2.channel = c.channel
                        ORDER BY m2.timestamp DESC, m2.rowid DESC
                        LIMIT 1
                    )
                    WHERE c.owner_zalo_id = ? AND c.channel = ?
                      AND m.msg_type IN (${mediaTypes.map(() => '?').join(', ')})
                `, [ownerZaloId, currentChannel, ...mediaTypes]);

                for (const row of rows) {
                    const caption = String(row.content || '');
                    const marker = getTelegramMessagePreview(row.msg_type, caption);
                    const previous = String(row.last_message || '');
                    // Group previews can start with "Sender: "; preserve it.
                    const prefix = caption && previous.endsWith(caption)
                        ? previous.slice(0, previous.length - caption.length)
                        : '';
                    const preview = `${prefix}${marker}`;
                    if (preview !== previous) {
                        this.run(
                            `UPDATE contacts SET last_message = ? WHERE owner_zalo_id = ? AND contact_id = ? AND channel = ?`,
                            [preview, ownerZaloId, row.contact_id, currentChannel]
                        );
                        repaired++;
                    }
                }
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] repairTelegramLastMessagePreviews error: ${err.message}`);
        }
        return repaired;
    }

    /**
     * Khi nhận event vote bình chọn (group.poll action=vote):
     * - Update content của tin nhắn group.poll gốc (cùng pollId) với content mới nhất
     * - Update last_message của contact = "[dName] đã bình chọn: [question]"
     * - KHÔNG tạo tin nhắn mới
     * Trả về true nếu tìm thấy và update được tin nhắn gốc.
     */
    public updatePollVoteMessage(
        ownerZaloId: string,
        threadId: string,
        pollId: string,
        newContent: string,
        voterName: string,
        question: string,
        timestamp: number,
        isSent: boolean,
    ): boolean {
        if (!this.initialized) return false;
        try {
            // Tìm tin nhắn group.poll gốc có pollId này
            const rows = this.query<any>(
                `SELECT msg_id FROM messages
                 WHERE owner_zalo_id=? AND thread_id=? AND msg_type='group.poll'
                 ORDER BY timestamp ASC`,
                [ownerZaloId, threadId]
            );

            let foundMsgId: string | null = null;
            for (const row of rows) {
                try {
                    const contentRow = this.queryOne<any>(
                        `SELECT content FROM messages WHERE owner_zalo_id=? AND msg_id=?`,
                        [ownerZaloId, row.msg_id]
                    );
                    const c = JSON.parse(contentRow?.content || '{}');
                    const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
                    if (String(params.pollId || '') === String(pollId)) {
                        foundMsgId = row.msg_id;
                        break;
                    }
                } catch {}
            }

            if (!foundMsgId) return false;

            // Update content và timestamp của tin nhắn gốc
            this.run(
                `UPDATE messages SET content=?, timestamp=? WHERE owner_zalo_id=? AND msg_id=?`,
                [newContent, timestamp, ownerZaloId, foundMsgId]
            );

            // Update last_message của contact
            const displayText = voterName
                ? `${voterName} đã bình chọn: ${question}`
                : `Có người bình chọn: ${question}`;
            const existing = this.queryOne<any>(
                'SELECT unread_count FROM contacts WHERE owner_zalo_id=? AND contact_id=?',
                [ownerZaloId, threadId]
            );
            if (existing) {
                const newUnread = !isSent ? (existing.unread_count || 0) + 1 : existing.unread_count;
                this.run(
                    'UPDATE contacts SET last_message=?, last_message_time=?, unread_count=? WHERE owner_zalo_id=? AND contact_id=?',
                    [displayText, timestamp, newUnread, ownerZaloId, threadId]
                );
            }
            return true;
        } catch (err: any) {
            Logger.error(`[DatabaseService] updatePollVoteMessage error: ${err.message}`);
            return false;
        }
    }

    private updateContactLastMessage(
        ownerZaloId: string, contactId: string, threadType: number,
        content: string, msgType: string, timestamp: number, incrementUnread: boolean
    ): void {
        // Guard: không tạo contact với contactId không hợp lệ
        if (!contactId || contactId === 'undefined' || contactId === 'null' || contactId === '') {
            Logger.warn(`[DB.updateContactLastMessage] ⚠️ SKIPPED - invalid contactId="${contactId}" for owner=${ownerZaloId}`);
            return;
        }
        const display = this.formatLastMessageContent(content, msgType);
        const unreadIncrement = incrementUnread ? 1 : 0;

        // Chỉ update last_message nếu tin nhắn mới hơn (hoặc chưa có contact)
        // Tránh old messages ghi đè last_message/last_message_time của hội thoại
        this.run(
            `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time)
             VALUES (?,?,?,?,0,?,?,?,?)
             ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
               last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
               last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
               unread_count=contacts.unread_count + ?`,
            [ownerZaloId, contactId, contactId, '', threadType === 1 ? 'group' : 'user', unreadIncrement, display, timestamp, unreadIncrement]
        );
    }

    /**
     * Cập nhật reaction của 1 user lên 1 tin nhắn (PHP-like accumulation format)
     * Reactions stored as: { total, lastReact, emoji: { emojiChar: { total, users: { userId: count } } } }
     */
    public updateMessageReaction(ownerZaloId: string, msgId: string, userId: string, rawIcon: string, threadId?: string): void {
        if (!this.initialized || !msgId) return;
        try {
            // Chỉ sửa ĐÚNG 1 dòng, ưu tiên khớp cả hội thoại: msg_id không duy nhất trong 1 tài khoản (Telegram: mỗi
            // kênh / nhóm có dãy ID riêng). Trước đây đọc + ghi theo (owner, msg_id) → reaction của 1 bài kênh trùng ID
            // (vd 💩17 🌚9) bị cộng thêm rồi ghi vào MỌI tin trùng ID ở các hội thoại khác.
            type ReactionRow = { id: number; reactions: string; channel: string | null };
            const row = (threadId
                ? this.queryOne<ReactionRow>(
                    `SELECT id, reactions, channel FROM messages WHERE owner_zalo_id = ? AND msg_id = ? AND ${SAME_THREAD_SQL} LIMIT 1`,
                    [ownerZaloId, String(msgId), String(threadId)]
                )
                : undefined)
                ?? this.queryOne<ReactionRow>(
                    'SELECT id, reactions, channel FROM messages WHERE owner_zalo_id = ? AND msg_id = ? LIMIT 1',
                    [ownerZaloId, String(msgId)]
                );
            if (!row) {
                Logger.warn(`[DatabaseService] updateMessageReaction: msg_id=${msgId} not found`);
                return;
            }
            // Telegram: số đếm là tổng hợp do Telegram trả (UpdateMessageReactions / kết quả SendReaction) — không
            // cộng dồn kiểu Zalo
            if (row.channel === 'telegram_user') return;
            // Zalo: "haha" từng được lưu 2 kiểu (😄 lúc thả, 😆 từ echo) → chuẩn hoá + gộp bản ghi cũ bị tách đôi
            const isZaloRow = !row.channel || row.channel === 'zalo';
            const icon = isZaloRow && rawIcon ? normalizeZaloReactionEmoji(rawIcon) : rawIcon;

            let parsed: any = {};
            try { parsed = JSON.parse(row.reactions || '{}'); } catch {}

            // Migrate old format { userId: emojiChar } → new format
            let reactions: { total: number; lastReact: string; emoji: Record<string, { total: number; users: Record<string, number> }> };
            if (parsed && parsed.emoji && typeof parsed.emoji === 'object') {
                reactions = isZaloRow ? mergeZaloReactionAliases(parsed) : parsed;
            } else {
                reactions = { total: 0, lastReact: '', emoji: {} };
                for (const [uid, emo] of Object.entries(parsed as Record<string, string>)) {
                    if (!emo) continue;
                    if (!reactions.emoji[emo]) reactions.emoji[emo] = { total: 0, users: {} };
                    reactions.emoji[emo].total++;
                    reactions.emoji[emo].users[uid] = (reactions.emoji[emo].users[uid] || 0) + 1;
                    reactions.total++;
                    reactions.lastReact = emo;
                }
            }

            if (!icon) {
                // Remove all reactions by this user
                for (const emo of Object.keys(reactions.emoji)) {
                    const userCount = reactions.emoji[emo].users[userId] || 0;
                    if (userCount > 0) {
                        reactions.emoji[emo].total -= userCount;
                        reactions.total -= userCount;
                        delete reactions.emoji[emo].users[userId];
                        if (reactions.emoji[emo].total <= 0) delete reactions.emoji[emo];
                    }
                }
            } else {
                // PHP-like: accumulate
                if (!reactions.emoji[icon]) {
                    reactions.emoji[icon] = { total: 1, users: { [userId]: 1 } };
                } else {
                    reactions.emoji[icon].total++;
                    reactions.emoji[icon].users[userId] = (reactions.emoji[icon].users[userId] || 0) + 1;
                }
                reactions.total++;
                reactions.lastReact = icon;
            }

            this.run('UPDATE messages SET reactions = ? WHERE id = ?', [JSON.stringify(reactions), row.id]);
        } catch (err: any) {
            Logger.error(`[DatabaseService] updateMessageReaction error: ${err.message}`);
        }
    }

    /**
     * Cập nhật local_paths của một tin nhắn sau khi download ảnh
     */
    public updateLocalPaths(ownerZaloId: string, msgId: string, localPaths: Record<string, string>): void {
        if (!this.initialized || !msgId) return;
        try {
            const row = this.queryOne<{ local_paths: string }>(
                'SELECT local_paths FROM messages WHERE owner_zalo_id = ? AND msg_id = ?',
                [ownerZaloId, String(msgId)]
            );
            if (!row) return;
            let existing: Record<string, string> = {};
            try { existing = JSON.parse(row.local_paths || '{}'); } catch {}
            const merged = { ...existing, ...localPaths };
            this.run(
                'UPDATE messages SET local_paths = ? WHERE owner_zalo_id = ? AND msg_id = ?',
                [JSON.stringify(merged), ownerZaloId, String(msgId)]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] updateLocalPaths error: ${err.message}`);
        }
    }

    /** Đánh dấu media (ảnh/video) của tin đã hết hạn trên CDN Zalo — UI hiện "đã hết hạn", không tải lại. */
    public setMediaExpired(ownerZaloId: string, msgId: string, expired: boolean): void {
        if (!this.initialized || !msgId) return;
        try {
            this.run(
                'UPDATE messages SET media_expired = ? WHERE owner_zalo_id = ? AND msg_id = ?',
                [expired ? 1 : 0, ownerZaloId, String(msgId)]
            );
        } catch (err: any) {
            Logger.warn(`[DatabaseService] setMediaExpired error: ${err.message}`);
        }
    }

    public isMediaExpired(ownerZaloId: string, msgId: string): boolean {
        if (!this.initialized || !msgId) return false;
        try {
            const row = this.queryOne<{ media_expired: number }>(
                'SELECT media_expired FROM messages WHERE owner_zalo_id = ? AND msg_id = ? LIMIT 1',
                [ownerZaloId, String(msgId)]
            );
            return Number(row?.media_expired) === 1;
        } catch {
            return false;
        }
    }

    // ─── Ảnh JPEG XL đã lưu → URL bản JPG (chạy nền 1 lần cho mỗi DB) ────────────

    // v2: v1 chỉ dò "/jxl/" nên sót URL trong chuỗi JSON escape "\/" (params.hd, quote.attach) và tin định dạng
    // cũ để URL ở cột attachments → chạy lại 1 lần cho mọi DB.
    private static readonly JXL_REPAIR_SETTING = 'zalo_jxl_to_jpg_v2';
    private jxlRepairTimer: NodeJS.Timeout | null = null;

    /**
     * Tin đã lưu trước khi có `normalizeZaloPhotoContent` còn URL ảnh `.jxl` (Chromium không hiển thị) →
     * đổi sang URL bản JPG và bỏ file `.jxl` đã tải. Chạy nền sau khi mở DB, theo từng khoảng id.
     */
    /**
     * Hội thoại Official Account có tin cuối là bản tin / thông báo zinstant (chat.webcontent / .v2): bản cũ lưu
     * last_message "[Đính kèm]" → chữ của OA ("📢 …"). Chạy 1 lần / DB; tin mới đã có xem trước đúng khi lưu.
     */
    private repairZaloZinstantPreviewsOnce(): void {
        const key = 'repair_zalo_zinstant_preview_v1';
        try {
            if (this.getSetting(key) === '1') return;
            const rows = this.query<{ owner_zalo_id: string; contact_id: string; last_message: string | null; content: string; msg_type: string }>(`
                SELECT c.owner_zalo_id, c.contact_id, c.last_message, m.content, m.msg_type
                FROM contacts c
                JOIN messages m ON m.rowid = (
                    SELECT m2.rowid FROM messages m2
                    WHERE m2.owner_zalo_id = c.owner_zalo_id AND m2.thread_id = c.contact_id
                    ORDER BY m2.timestamp DESC, m2.rowid DESC
                    LIMIT 1
                )
                WHERE COALESCE(c.channel, 'zalo') = 'zalo'
                  AND COALESCE(c.last_message, '') IN ('[Đính kèm]', '')
                  AND m.msg_type IN ('chat.webcontent', 'chat.webcontent.v2')
            `);
            let repaired = 0;
            for (const row of rows) {
                const preview = zinstantPreviewText(row.content, row.msg_type);
                if (!preview || preview === row.last_message) continue;
                this.run('UPDATE contacts SET last_message = ? WHERE owner_zalo_id = ? AND contact_id = ?', [preview, row.owner_zalo_id, row.contact_id]);
                repaired++;
            }
            this.setSetting(key, '1');
            if (repaired) Logger.log(`[DatabaseService] Zalo OA zinstant previews repaired: ${repaired}`);
        } catch (err: any) {
            Logger.warn(`[DatabaseService] repairZaloZinstantPreviewsOnce: ${err?.message}`);
        }
    }

    private scheduleJxlImageRepair(): void {
        if (this.jxlRepairTimer) clearTimeout(this.jxlRepairTimer);
        this.jxlRepairTimer = setTimeout(() => {
            this.jxlRepairTimer = null;
            this.repairStoredJxlImages().catch(err => Logger.warn(`[DatabaseService] repairStoredJxlImages: ${err?.message}`));
        }, 15000);
        this.jxlRepairTimer.unref?.();
    }

    private async repairStoredJxlImages(): Promise<void> {
        const target = db;
        if (!target || !this.initialized) return;
        if (this.getSetting(DatabaseService.JXL_REPAIR_SETTING) === '1') return;
        const maxRow = target.prepare('SELECT MAX(id) AS maxId FROM messages').get() as { maxId: number | null } | undefined;
        const maxId = Number(maxRow?.maxId) || 0;
        // Dò "jxl" (không phải "/jxl/"): URL trong chuỗi JSON lồng bị escape thành "\/jxl\/".
        const select = target.prepare(
            `SELECT id, content, local_paths, quote_data, attachments FROM messages
             WHERE id > ? AND id <= ?
               AND (content LIKE '%jxl%' OR quote_data LIKE '%jxl%' OR attachments LIKE '%jxl%' OR local_paths LIKE '%.jxl%')`
        );
        const update = target.prepare('UPDATE messages SET content = ?, local_paths = ?, quote_data = ?, attachments = ? WHERE id = ?');
        // Mỗi lần quét 10.000 dòng (đo trên DB 2,7 triệu tin: ≤ ~140ms/lần, cả DB ~10s), nhường event loop
        // giữa các lần để không chặn main process.
        const CHUNK = 10000;
        const staleFiles: string[] = [];
        let fixed = 0;
        for (let from = 0; from < maxId; from += CHUNK) {
            if (db !== target) return; // đổi workspace giữa chừng → lần mở DB sau chạy lại
            const rows = select.all(from, from + CHUNK) as Array<{
                id: number; content: string; local_paths: string | null; quote_data: string | null; attachments: string | null;
            }>;
            if (rows.length) {
                target.transaction(() => {
                    for (const row of rows) {
                        const content = normalizeZaloPhotoContent(row.content);
                        const quoteData = this.normalizeQuoteDataJxl(row.quote_data);
                        const attachments = this.normalizeAttachmentsJxl(row.attachments);
                        const localPaths = this.dropJxlLocalPaths(row.local_paths, staleFiles);
                        if (content === row.content && quoteData === row.quote_data
                            && attachments === row.attachments && localPaths === row.local_paths) continue;
                        update.run(content, localPaths, quoteData, attachments, row.id);
                        fixed++;
                    }
                })();
            }
            await new Promise(resolve => setImmediate(resolve));
        }
        if (db !== target) return;
        this.setSetting(DatabaseService.JXL_REPAIR_SETTING, '1');
        for (const file of staleFiles) {
            try { fs.unlinkSync(FileStorageService.resolveAbsolutePath(file)); } catch { /* đã xoá */ }
        }
        Logger.log(`[DatabaseService] Ảnh JPEG XL → JPG: sửa ${fixed} tin, xoá ${staleFiles.length} file .jxl`);
    }

    private normalizeQuoteDataJxl(quoteData: string | null): string | null {
        if (!quoteData || !/jxl/i.test(quoteData)) return quoteData;
        try {
            const parsed = JSON.parse(quoteData);
            if (!parsed || typeof parsed !== 'object') return quoteData;
            const attach = normalizeZaloPhotoContent(parsed.attach);
            const imageUrl = typeof parsed.imageUrl === 'string' ? toZaloJpgUrl(parsed.imageUrl) : parsed.imageUrl;
            if (attach === parsed.attach && imageUrl === parsed.imageUrl) return quoteData;
            return JSON.stringify({ ...parsed, attach, imageUrl });
        } catch {
            return quoteData;
        }
    }

    /** Tin Zalo định dạng cũ (content "[Photo]") để URL ảnh trong cột attachments: mảng object có hd/href/thumb. */
    private normalizeAttachmentsJxl(attachments: string | null): string | null {
        if (!attachments || !/jxl/i.test(attachments)) return attachments;
        try {
            const parsed = JSON.parse(attachments);
            if (!Array.isArray(parsed)) return attachments;
            let changed = false;
            const next = parsed.map(item => {
                const fixed = normalizeZaloPhotoContent(item);
                if (fixed !== item) changed = true;
                return fixed;
            });
            return changed ? JSON.stringify(next) : attachments;
        } catch {
            return attachments;
        }
    }

    /** Bỏ đường dẫn file `.jxl` khỏi local_paths (ghi lại để xoá file); bubble sẽ hiện bản JPG từ CDN rồi tải lại. */
    private dropJxlLocalPaths(localPaths: string | null, staleFiles: string[]): string | null {
        if (!localPaths || !/\.jxl"/i.test(localPaths)) return localPaths;
        try {
            const parsed = JSON.parse(localPaths);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return localPaths;
            let changed = false;
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === 'string' && /\.jxl$/i.test(value)) {
                    staleFiles.push(value);
                    delete parsed[key];
                    changed = true;
                }
            }
            return changed ? JSON.stringify(parsed) : localPaths;
        } catch {
            return localPaths;
        }
    }

    /**
     * Bulk-replace media path prefix in ALL messages after moving the storage folder.
     * Handles both Windows backslash paths (JSON-escaped as \\) and forward-slash paths.
     * Returns the number of messages updated.
     */
    public rewriteLocalPaths(oldPrefix: string, newPrefix: string): number {
        if (!this.initialized || !oldPrefix || !newPrefix || oldPrefix === newPrefix) return 0;
        try {
            const variants: Array<[string, string]> = [
                [oldPrefix, newPrefix],
                [oldPrefix.replace(/\\/g, '\\\\'), newPrefix.replace(/\\/g, '\\\\')],
                [oldPrefix.replace(/\\/g, '/'),    newPrefix.replace(/\\/g, '/')],
            ];
            let updated = 0;
            // UDF: no parameter binding - all logic runs in pure JS callback
            db!.function('_rewrite_local_path', (jsonStr: string): string => {
                if (!jsonStr) return jsonStr;
                let text = jsonStr;
                let changed = false;
                for (const [from, to] of variants) {
                    if (text.includes(from)) { text = text.split(from).join(to); changed = true; }
                }
                if (changed) updated++;
                return text;
            });
            db!.exec(
                `UPDATE messages SET local_paths = _rewrite_local_path(local_paths)
                 WHERE local_paths IS NOT NULL AND local_paths != '' AND local_paths != '{}' AND local_paths != 'null'`
            );
            if (updated > 0) this.save();
            Logger.log(`[DatabaseService] rewriteLocalPaths: updated ${updated} messages`);
            return updated;
        } catch (err: any) {
            Logger.error(`[DatabaseService] rewriteLocalPaths error: ${err?.message ?? String(err)}`);
            return 0;
        }
    }

    /**
     * Convert ALL absolute local_paths → "media/zaloId/date/img.jpg" (relative to configFolder).
     * Uses sql.js create_function (UDF) - single SQL UPDATE, zero parameter binding.
     * This bypasses the sql.js Wasm "unknown type undefined" error that occurs when trying
     * to bind rowid values (sql.js does not expose rowid via getAsObject).
     */
    public migrateAllAbsolutePathsToRelative(): number {
        if (!this.initialized) return 0;
        // This migration used to execute an UPDATE/UDF over every message with
        // local_paths at every launch. On a multi-million-message database it
        // blocks Electron's main process even after every path is already
        // relative. Persist completion so the compatibility scan runs at most
        // once for this database.
        const migrationKey = 'migration_local_paths_relative_v2';
        if (this.getSetting(migrationKey) === 'done') return 0;

        let migrationCount = 0;
        try {
            // JS UDF: receives local_paths JSON string, returns transformed string.
            // No Wasm param binding - all transformation runs in JavaScript.
            db!.function('_migrate_local_path', (jsonStr: string): string => {
                if (!jsonStr) return jsonStr;
                try {
                    const lp: Record<string, string> = JSON.parse(jsonStr);
                    let changed = false;
                    for (const key of Object.keys(lp)) {
                        const val: string = lp[key] || '';
                        if (!val || typeof val !== 'string') continue;
                        const normalized = val.replace(/\\/g, '/');
                        // Skip already-relative paths (no drive letter, no leading '/')
                        if (!/^[A-Za-z]:\//.test(normalized) && !normalized.startsWith('/')) continue;
                        const idx = normalized.lastIndexOf('/media/');
                        if (idx >= 0) {
                            lp[key] = normalized.slice(idx + 1); // → "media/zaloId/date/img.jpg"
                            changed = true;
                            migrationCount++;
                        }
                    }
                    return changed ? JSON.stringify(lp) : jsonStr;
                } catch { return jsonStr; }
            });

            // Only feed the UDF rows that can still contain an absolute path.
            // JSON stores Windows separators escaped as `\\`, while an absolute
            // Unix path includes `/media/`. Already-relative `media/...` values
            // match neither condition.
            db!.exec(
                `UPDATE messages SET local_paths = _migrate_local_path(local_paths)
                 WHERE local_paths IS NOT NULL
                   AND local_paths != ''
                   AND local_paths != '{}'
                   AND local_paths != 'null'
                   AND (instr(local_paths, ':\\\\') > 0 OR instr(local_paths, '/media/') > 0)`
            );

            // better-sqlite3 persists through WAL immediately. Do not force a
            // TRUNCATE checkpoint here: that can stall startup for minutes on
            // a large database.
            this.setSetting(migrationKey, 'done');
            Logger.log(`[DatabaseService] migrateAllAbsolutePathsToRelative: ${migrationCount} paths converted`);
            return migrationCount;
        } catch (err: any) {
            Logger.error(`[DatabaseService] migrateAllAbsolutePathsToRelative error: ${err?.message ?? String(err)}`);
            return 0;
        }
    }

    /**
     * Convert all absolute paths in local_paths that start with baseDir to
     * folder-agnostic relative paths (forward-slash, no leading slash).
     * This is safer than rewriteLocalPaths because it parses the JSON instead
     * of doing raw string replacement.
     *
     * Example:
     *   baseDir = "C:\Users\Admin\AppData\Roaming\Deplao\media"
     *   stored  = {"main":"C:\\Users\\Admin\\...\\media\\zaloId\\date\\img.jpg"}
     *   →         {"main":"zaloId/date/img.jpg"}
     *
     * Returns the number of messages updated.
     */
    public migratePathsToRelative(baseDir: string): number {
        if (!this.initialized || !baseDir) return 0;
        // Normalise baseDir to forward-slash, with trailing slash
        const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/?$/, '') + '/';
        try {
            const rows = this.query<{ rowid: number; local_paths: string }>(
                `SELECT rowid, local_paths FROM messages
                 WHERE local_paths IS NOT NULL
                   AND local_paths != ''
                   AND local_paths != '{}'
                   AND local_paths != 'null'`
            );
            let updated = 0;
            for (const row of rows) {
                try {
                    const lp: Record<string, string> = JSON.parse(row.local_paths);
                    let changed = false;
                    for (const key of Object.keys(lp)) {
                        const val: string = lp[key] || '';
                        if (!val || typeof val !== 'string') continue;
                        // Normalise value to forward-slash for comparison
                        const normalizedVal = val.replace(/\\/g, '/');
                        if (normalizedVal.startsWith(normalizedBase)) {
                            lp[key] = normalizedVal.slice(normalizedBase.length);
                            changed = true;
                        }
                    }
                    if (changed) {
                        this.run(
                            'UPDATE messages SET local_paths = ? WHERE rowid = ?',
                            [JSON.stringify(lp), row.rowid]
                        );
                        updated++;
                    }
                } catch { /* skip malformed JSON */ }
            }
            Logger.log(`[DatabaseService] migratePathsToRelative: ${updated} messages converted to relative paths (base="${baseDir}")`);
            return updated;
        } catch (err: any) {
            Logger.error(`[DatabaseService] migratePathsToRelative error: ${err.message}`);
            return 0;
        }
    }

    /**
     * Xóa nhiều tin nhắn theo danh sách msgId
     */
    public deleteMessages(ownerZaloId: string, msgIds: string[], threadId?: string): void {
        if (!this.initialized || !msgIds.length) return;
        try {
            // Telegram: msg_id chỉ duy nhất trong 1 hội thoại → xoá đúng hội thoại, không bao giờ xoá theo msg_id trần
            const scoped = db!.prepare(`DELETE FROM messages WHERE owner_zalo_id = ? AND msg_id = ? AND ${SAME_THREAD_SQL}`);
            const unscoped = db!.prepare(
                `DELETE FROM messages WHERE owner_zalo_id = ? AND msg_id = ? AND COALESCE(channel, 'zalo') NOT IN ('telegram_user', 'telegram_bot')`,
            );
            for (const msgId of msgIds) {
                const scope = this.messageIdScope(ownerZaloId, String(msgId), threadId);
                if (scope.params.length) scoped.run(ownerZaloId, String(msgId), scope.params[0]);
                else unscoped.run(ownerZaloId, String(msgId));
            }
            this.save();
            Logger.log(`[DatabaseService] Deleted ${msgIds.length} messages for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] deleteMessages error: ${err.message}`);
        }
    }

    /**
     * Đánh dấu tin nhắn bị xoá bởi trưởng/phó nhóm (không xoá khỏi DB, chỉ set deleted_by)
     */
    public markMessageDeletedByAdmin(ownerZaloId: string, msgIds: string[], deletedByUid: string): void {
        if (!this.initialized || !msgIds.length) return;
        try {
            const stmt = db!.prepare(
                `UPDATE messages SET deleted_by = ? WHERE owner_zalo_id = ? AND msg_id = ?`
            );
            for (const msgId of msgIds) {
                stmt.run(deletedByUid, ownerZaloId, String(msgId));
            }
            this.save();
            Logger.log(`[DatabaseService] Marked ${msgIds.length} messages deleted_by=${deletedByUid} for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] markMessageDeletedByAdmin error: ${err.message}`);
        }
    }

    public getTotalUnread(ownerZaloId: string): number {
        const row = this.queryOne<{ total: number }>(
            'SELECT SUM(unread_count) as total FROM contacts WHERE owner_zalo_id = ?',
            [ownerZaloId]
        );
        return row?.total || 0;
    }

    // ─── Friend Cache Operations ──────────────────────────────────────────

    /** Kiểm tra nhanh 1 userId có trong bảng friends không */
    public checkIsFriend(ownerZaloId: string, userId: string): boolean {
        if (!this.initialized) return false;
        // 1. Check dedicated friends table (populated by saveFriends / addFriend)
        const friendRow = this.queryOne<any>(
            'SELECT 1 FROM friends WHERE owner_zalo_id=? AND user_id=? LIMIT 1',
            [ownerZaloId, userId]
        );
        if (friendRow) return true;
        // 2. Fallback: check contacts.is_friend flag (populated by Zalo contact sync)
        //    This handles the case where friends table hasn't been synced yet
        const contactRow = this.queryOne<any>(
            'SELECT is_friend FROM contacts WHERE owner_zalo_id=? AND contact_id=? LIMIT 1',
            [ownerZaloId, userId]
        );
        return contactRow?.is_friend === 1;
    }

    /** Lưu toàn bộ danh sách bạn bè vào DB (upsert) - batch: single prepare + single save */
    public saveFriends(ownerZaloId: string, friends: Array<{ userId: string; displayName?: string; zaloName?: string; avatar?: string; phoneNumber?: string }>): void {
        if (!this.initialized) return;
        const now = Date.now();
        try {
            const stmt = db!.prepare(
                `INSERT INTO friends (owner_zalo_id, user_id, display_name, avatar, phone, updated_at)
                 VALUES (?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   updated_at=excluded.updated_at`
            );
            for (const f of friends) {
                if (!f.userId) continue;
                stmt.run(ownerZaloId, f.userId, f.displayName || f.zaloName || f.userId, f.avatar || '', this.normalizeVietnamPhone(f.phoneNumber || ''), now);
            }
            this.save();
            Logger.log(`[DatabaseService] Saved ${friends.length} friends for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveFriends error: ${err.message}`);
        }
    }

    /**
     * Batch upsert contacts - single prepare + single disk write.
     * Dùng cho fetchAllFriendsInBackground thay vì gọi saveContact() từng dòng.
     */
    public saveContactsBatch(contacts: Array<Omit<Contact, 'id'>>): void {
        if (!this.initialized || contacts.length === 0) return;
        try {
            const stmt = db!.prepare(
                `INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count, last_message, last_message_time)
                 VALUES (?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar_url=excluded.avatar_url,
                   phone=CASE WHEN excluded.phone != '' THEN excluded.phone ELSE contacts.phone END,
                   is_friend=excluded.is_friend,
                   contact_type=excluded.contact_type`
            );
            for (const c of contacts) {
                const normalizedPhone = this.normalizeVietnamPhone(c.phone || '');
                stmt.run(
                    c.owner_zalo_id, c.contact_id, c.display_name, c.avatar_url,
                    normalizedPhone, c.is_friend, c.contact_type,
                    c.unread_count || 0, c.last_message || '', c.last_message_time || 0,
                );
            }
            this.save();
            Logger.log(`[DatabaseService] Batch saved ${contacts.length} contacts`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveContactsBatch error: ${err.message}`);
        }
    }

    /**
     * Kiểm tra nhanh 1 contact có tồn tại trong DB không (single-row lookup).
     * Tránh load toàn bộ contacts chỉ để check 1 row.
     */
    public getContactById(ownerZaloId: string, contactId: string): Contact | undefined {
        if (!this.initialized) return undefined;
        return this.queryOne<Contact>(
            'SELECT * FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?',
            [ownerZaloId, contactId]
        );
    }

    /** Lấy danh sách bạn bè đã cache từ DB */
    public getFriends(ownerZaloId: string): Array<{ userId: string; displayName: string; avatar: string; phoneNumber: string; updatedAt: number }> {
        if (!this.initialized) return [];
        try {
            const rows = this.query<any>(
                'SELECT user_id, display_name, avatar, phone, updated_at FROM friends WHERE owner_zalo_id = ? ORDER BY display_name',
                [ownerZaloId]
            );
            return rows.map(r => ({
                userId: r.user_id,
                displayName: r.display_name || r.user_id,
                avatar: r.avatar || '',
                phoneNumber: r.phone || '',
                updatedAt: r.updated_at || 0,
            }));
        } catch (err: any) {
            Logger.error(`[DatabaseService] getFriends error: ${err.message}`);
            return [];
        }
    }

    /** Trả về timestamp lần cuối cache bạn bè, 0 nếu chưa có */
    public getFriendsLastFetched(ownerZaloId: string): number {
        if (!this.initialized) return 0;
        try {
            const row = this.queryOne<{ max_ts: number }>(
                'SELECT MAX(updated_at) as max_ts FROM friends WHERE owner_zalo_id = ?',
                [ownerZaloId]
            );
            return row?.max_ts || 0;
        } catch {
            return 0;
        }
    }

    // ─── Friend Request Cache Operations ─────────────────────────────────

    /**
     * Lưu/cập nhật một lời mời kết bạn vào DB
     * @param direction 'received' = người khác gửi cho mình | 'sent' = mình gửi đi
     */
    public upsertFriendRequest(
        ownerZaloId: string,
        request: { userId: string; displayName?: string; avatar?: string; phone?: string; msg?: string; createdAt?: number },
        direction: 'received' | 'sent'
    ): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT INTO friend_requests (owner_zalo_id, user_id, display_name, avatar, phone, direction, msg, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id, direction) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   msg=excluded.msg,
                   updated_at=excluded.updated_at`,
                [
                    ownerZaloId,
                    request.userId,
                    request.displayName || '',
                    request.avatar || '',
                    this.normalizeVietnamPhone(request.phone || ''),
                    direction,
                    request.msg || '',
                    request.createdAt || Date.now(),
                    Date.now(),
                ]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] upsertFriendRequest error: ${err.message}`);
        }
    }

    /** Lưu hàng loạt lời mời (replace toàn bộ cho direction đó) */
    public saveFriendRequests(
        ownerZaloId: string,
        requests: Array<{ userId: string; displayName?: string; avatar?: string; phone?: string; msg?: string; createdAt?: number }>,
        direction: 'received' | 'sent'
    ): void {
        if (!this.initialized) return;
        try {
            // Xóa toàn bộ record cũ cho direction này rồi insert mới
            this.runNoSave(
                `DELETE FROM friend_requests WHERE owner_zalo_id = ? AND direction = ?`,
                [ownerZaloId, direction]
            );
            const now = Date.now();
            const stmt = db!.prepare(
                `INSERT OR IGNORE INTO friend_requests (owner_zalo_id, user_id, display_name, avatar, phone, direction, msg, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`
            );
            for (const req of requests) {
                if (!req.userId) continue;
                stmt.run(ownerZaloId, req.userId, req.displayName || '', req.avatar || '', this.normalizeVietnamPhone(req.phone || ''), direction, req.msg || '', req.createdAt || now, now);
            }
            this.save();
            Logger.log(`[DatabaseService] Saved ${requests.length} ${direction} friend requests for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] saveFriendRequests error: ${err.message}`);
        }
    }

    /** Lấy danh sách lời mời từ DB */
    public getFriendRequests(
        ownerZaloId: string,
        direction: 'received' | 'sent'
    ): Array<{ userId: string; displayName: string; avatar: string; phone: string; msg: string; createdAt: number; updatedAt: number }> {
        if (!this.initialized) return [];
        try {
            const rows = this.query<any>(
                `SELECT user_id, display_name, avatar, phone, msg, created_at, updated_at
                 FROM friend_requests
                 WHERE owner_zalo_id = ? AND direction = ?
                 ORDER BY created_at DESC`,
                [ownerZaloId, direction]
            );
            return rows.map(r => ({
                userId: r.user_id,
                displayName: r.display_name || r.user_id,
                avatar: r.avatar || '',
                phone: r.phone || '',
                msg: r.msg || '',
                createdAt: r.created_at || 0,
                updatedAt: r.updated_at || 0,
            }));
        } catch (err: any) {
            Logger.error(`[DatabaseService] getFriendRequests error: ${err.message}`);
            return [];
        }
    }

    /** Xóa một lời mời kết bạn khỏi DB (khi chấp nhận/từ chối/hủy) */
    public removeFriendRequest(ownerZaloId: string, userId: string, direction: 'received' | 'sent'): void {
        if (!this.initialized) return;
        try {
            this.run(
                `DELETE FROM friend_requests WHERE owner_zalo_id = ? AND user_id = ? AND direction = ?`,
                [ownerZaloId, userId, direction]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] removeFriendRequest error: ${err.message}`);
        }
    }

    /** Thêm bạn bè mới vào bảng friends khi accept lời mời */
    public addFriend(
        ownerZaloId: string,
        friend: { userId: string; displayName?: string; avatar?: string; phone?: string }
    ): void {
        if (!this.initialized || !friend.userId) return;
        try {
            this.run(
                `INSERT INTO friends (owner_zalo_id, user_id, display_name, avatar, phone, updated_at)
                 VALUES (?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   updated_at=excluded.updated_at`,
                [ownerZaloId, friend.userId, friend.displayName || '', friend.avatar || '', this.normalizeVietnamPhone(friend.phone || ''), Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] addFriend error: ${err.message}`);
        }
    }

    /** Xóa bạn bè khỏi bảng friends */
    public removeFriend(ownerZaloId: string, userId: string): void {
        if (!this.initialized) return;
        try {
            this.run(
                `DELETE FROM friends WHERE owner_zalo_id = ? AND user_id = ?`,
                [ownerZaloId, userId]
            );
        } catch (err: any) {
            Logger.error(`[DatabaseService] removeFriend error: ${err.message}`);
        }
    }

    /** Lấy timestamp lần cuối cache lời mời */
    public getFriendRequestsLastFetched(ownerZaloId: string, direction: 'received' | 'sent'): number {
        if (!this.initialized) return 0;
        try {
            const row = this.queryOne<{ max_ts: number }>(
                'SELECT MAX(updated_at) as max_ts FROM friend_requests WHERE owner_zalo_id = ? AND direction = ?',
                [ownerZaloId, direction]
            );
            return row?.max_ts || 0;
        } catch {
            return 0;
        }
    }

    public markAsRead(ownerZaloId: string, contactId: string): void {
        if (!this.initialized) return;
        this.runNoSave('UPDATE contacts SET unread_count = 0 WHERE owner_zalo_id = ? AND contact_id = ? AND unread_count != 0', [ownerZaloId, contactId]);
        // Chỉ xét MARK_READ_SCOPE tin mới nhất (chỉ mục thread, tra theo rowid): tin chưa đọc luôn là tin mới nhất, và
        // trạng thái 'read' của tin NHẬN không dùng để hiển thị. Trước đây lọc is_sent/status trên cả hội thoại → quét
        // hết tin mỗi lần mở (113k tin ≈ 0,9–2 s khi đĩa nguội), chặn main nên db:getMessages phải xếp hàng chờ.
        this.runNoSave(
            `UPDATE messages SET status = 'read'
             WHERE id IN (SELECT id FROM messages WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ?)
               AND is_sent = 0 AND status != 'read'`,
            [ownerZaloId, contactId, MARK_READ_SCOPE],
        );
        this.save();
    }

    /**
     * Phạm vi hàng cho thao tác theo msg_id. Telegram: msg_id chỉ duy nhất trong 1 hội thoại (mỗi kênh / siêu nhóm một dãy
     * số) → có `threadId` và tin nằm trong hội thoại đó thì chỉ đụng hội thoại đó; ngoài ra không bao giờ đụng hàng
     * Telegram theo msg_id trần (bài kênh trùng số bị ghi đè / xoá mất). Zalo / Facebook: msg_id duy nhất — giữ cách cũ
     * khi threadId không khớp.
     */
    private messageIdScope(ownerZaloId: string, msgId: string, threadId?: string): { sql: string; params: string[] } {
        const thread = String(threadId || '');
        if (thread && (
            this.queryOne<any>(`SELECT 1 FROM messages WHERE owner_zalo_id = ? AND msg_id = ? AND ${SAME_THREAD_SQL} LIMIT 1`,
                [ownerZaloId, String(msgId), thread])
            || this.queryOne<any>(`SELECT 1 FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND ${SAME_THREAD_SQL} LIMIT 1`,
                [ownerZaloId, String(msgId), thread])
        )) {
            return { sql: ` AND ${SAME_THREAD_SQL}`, params: [thread] };
        }
        return { sql: ` AND COALESCE(channel, 'zalo') NOT IN ('telegram_user', 'telegram_bot')`, params: [] };
    }

    /** Đánh dấu tin nhắn là đã thu hồi, giữ cả nội dung lẫn loại media gốc để có thể xem lại. */
    public markMessageRecalled(ownerZaloId: string, msgId: string, threadId?: string): void {
        if (!this.initialized || !msgId) return;
        const recalledContent = JSON.stringify({ msg: 'Tin nhắn đã bị thu hồi' });
        const scope = this.messageIdScope(ownerZaloId, String(msgId), threadId);

        // Keep the original content/type on the first recall event. Zalo can
        // deliver duplicate undo events; a duplicate must never overwrite the
        // preserved media metadata with the recalled placeholder.
        const existing = this.queryOne<any>(
            `SELECT msg_id, content, msg_type, recalled_content, recalled_msg_type FROM messages WHERE owner_zalo_id = ? AND msg_id = ?${scope.sql}`,
            [ownerZaloId, String(msgId), ...scope.params]
        ) || this.queryOne<any>(
            `SELECT msg_id, content, msg_type, recalled_content, recalled_msg_type FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND msg_type != 'recalled'${scope.sql}`,
            [ownerZaloId, String(msgId), ...scope.params]
        );
        // Không có tin (chưa lưu / ngoài phạm vi) → không có gì để đánh dấu (UPDATE bên dưới cũng không khớp hàng nào)
        if (!existing) return;
        const originalContent = existing?.recalled_content ?? existing?.content ?? null;
        const originalMsgType = existing?.recalled_msg_type || (existing?.msg_type !== 'recalled' ? existing?.msg_type : null);

        const SQL = `UPDATE messages SET
            is_recalled = 1,
            status = 'recalled',
            msg_type = 'recalled',
            content = ?,
            recalled_content = CASE WHEN recalled_content IS NULL OR recalled_content = '' THEN ? ELSE recalled_content END,
            recalled_msg_type = CASE WHEN recalled_msg_type IS NULL OR recalled_msg_type = '' THEN ? ELSE recalled_msg_type END
            WHERE owner_zalo_id = ? AND `;
        if (this.queryOne<any>(`SELECT 1 FROM messages WHERE owner_zalo_id = ? AND msg_id = ?${scope.sql}`, [ownerZaloId, String(msgId), ...scope.params])) {
            this.run(SQL + `msg_id = ?${scope.sql}`, [recalledContent, originalContent, originalMsgType, ownerZaloId, String(msgId), ...scope.params]);
        } else {
            this.run(SQL + `cli_msg_id = ? AND msg_type != 'recalled'${scope.sql}`, [recalledContent, originalContent, originalMsgType, ownerZaloId, String(msgId), ...scope.params]);
        }
    }

    /** Nếu tin nhắn bị thu hồi là last_message của conversation, cập nhật preview */
    public updateLastMessageIfRecalled(ownerZaloId: string, threadId: string, msgId: string): void {
        if (!this.initialized || !threadId) return;
        try {
            const contact = this.queryOne<any>('SELECT last_message FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, threadId]);
            if (!contact) return;
            const lastMsg = this.queryOne<any>(
                `SELECT content, msg_type, timestamp FROM messages WHERE owner_zalo_id = ? AND ${SAME_THREAD_SQL} AND msg_id = ?`,
                [ownerZaloId, threadId, String(msgId)]
            );
            if (lastMsg) {
                this.run(
                    'UPDATE contacts SET last_message = ? WHERE owner_zalo_id = ? AND contact_id = ?',
                    ['Tin nhắn đã bị thu hồi', ownerZaloId, threadId]
                );
            }
        } catch (err: any) {
            Logger.warn(`[DatabaseService] updateLastMessageIfRecalled: ${err.message}`);
        }
    }

    public getMessageById(ownerZaloId: string, msgId: string, threadId?: string): Message | undefined {
        if (!this.initialized || !msgId) return undefined;
        const m = String(msgId);
        // Zalo TQuote points at globalMsgId; media events may have been persisted
        // with a distinct cli_msg_id, while ordinary text commonly has both IDs
        // equal. The old `(msg_id = ? OR cli_msg_id = ?)` OR defeats the
        // (msg_id, owner, channel, thread_id) unique index → full scan (đo ~28s
        // trên tài khoản 1.3M tin). Tách thành 2 lần tra index thay vì OR.
        //
        // 1) Tra msg_id trước (unique index). msg_id chỉ unique theo (owner,
        //    channel, thread); với Telegram msg_id có thể lặp giữa các chat nên
        //    chốt deterministic bằng `id DESC` (dòng mới nhất thắng).
        //    Hội thoại: SAME_THREAD_SQL (thread_id = ? làm SQLite quét cả hội thoại).
        const byMsgId = threadId
            ? this.queryOne<Message>(
                `SELECT * FROM messages
                 WHERE owner_zalo_id = ? AND msg_id = ? AND ${SAME_THREAD_SQL}
                 ORDER BY id DESC LIMIT 1`,
                [ownerZaloId, m, threadId]
            )
            : this.queryOne<Message>(
                `SELECT * FROM messages
                 WHERE owner_zalo_id = ? AND msg_id = ?
                 ORDER BY id DESC LIMIT 1`,
                [ownerZaloId, m]
            );
        if (byMsgId) return byMsgId;
        // 2) Fallback sang cli_msg_id (idx_messages_cli) cho tin media/quote
        //    chỉ lưu client id.
        return threadId
            ? this.queryOne<Message>(
                `SELECT * FROM messages
                 WHERE owner_zalo_id = ? AND cli_msg_id = ? AND ${SAME_THREAD_SQL}
                 ORDER BY id DESC LIMIT 1`,
                [ownerZaloId, m, threadId]
            )
            : this.queryOne<Message>(
                `SELECT * FROM messages
                 WHERE owner_zalo_id = ? AND cli_msg_id = ?
                 ORDER BY id DESC LIMIT 1`,
                [ownerZaloId, m]
            );
    }

    /** Batch lookup: lấy nhiều messages theo IDs trong 1 query */
    public getMessagesByIds(ownerZaloId: string, msgIds: string[]): Message[] {
        if (!this.initialized || !msgIds.length) return [];
        const placeholders = msgIds.map(() => '?').join(',');
        return this.query<Message>(
            `SELECT * FROM messages WHERE owner_zalo_id = ? AND msg_id IN (${placeholders})`,
            [ownerZaloId, ...msgIds.map(String)]
        );
    }

    /** Xóa hội thoại khỏi DB (xóa contact + toàn bộ tin nhắn) */
    public deleteConversation(ownerZaloId: string, contactId: string): void {
        if (!this.initialized) return;
        try {
            this.runNoSave('DELETE FROM messages WHERE owner_zalo_id = ? AND thread_id = ?', [ownerZaloId, contactId]);
            this.runNoSave('DELETE FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId]);
            this.save();
            Logger.log(`[DatabaseService] Deleted conversation ${contactId} for ${ownerZaloId}`);
        } catch (err: any) {
            Logger.error(`[DatabaseService] deleteConversation error: ${err.message}`);
        }
    }

    // ─── Settings Operations ──────────────────────────────────────────────

    public getSetting(key: string): string | null {
        if (!this.initialized) return null;
        const row = this.queryOne<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key]);
        return row?.value ?? null;
    }

    public setSetting(key: string, value: string): void {
        if (!this.initialized) return;
        this.run(
            `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            [key, value]
        );
    }

    // ─── Image URL Helpers ────────────────────────────────────────────────

    /** Trích xuất URL ảnh từ object content Zalo */
    public static extractImageUrlFromContent(contentRaw: any): string {
        if (!contentRaw || typeof contentRaw !== 'object') return '';
        let p: any = contentRaw.params;
        if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
        return (p?.hd || p?.rawUrl) || contentRaw.normalUrl || contentRaw.hdUrl || contentRaw.hd || contentRaw.href || contentRaw.thumb || contentRaw.url || '';
    }

    /**
     * Chuyển đổi cliMsgType (số nguyên từ TQuote) sang msgType (string dùng trong zca-js)
     * Ánh xạ ngược của getClientMessageType() trong zca-js/utils.js
     */
    public static clientMsgTypeToMsgType(cliMsgType: number): string {
        switch (cliMsgType) {
            case 1:  return 'webchat';
            case 31: return 'chat.voice';
            case 32: return 'chat.photo';
            case 36: return 'chat.sticker';
            case 37: return 'chat.doodle';
            case 38: return 'chat.recommended';
            case 43: return 'chat.location.new';
            case 44: return 'chat.video.msg';
            case 46: return 'share.file';
            case 49: return 'chat.gif';
            default: return 'webchat';
        }
    }

    /** Trích xuất URL ảnh từ quote data */
    public extractImageUrlFromQuote(rawQuote: any): string {
        if (!rawQuote) return '';
        const attach = rawQuote.attach;
        const msg = rawQuote.msg;

        /** chỉ trả về URL ảnh CDN, tránh trả về href trang web thông thường */
        const isImageUrl = (url: string): boolean => {
            if (!url) return false;
            return /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url) ||
                /zdn\.vn|zadn\.vn|cloudfront\.net/i.test(url);
        };

        // 1. Thử attach
        if (attach) {
            try {
                const parsed = typeof attach === 'string' ? JSON.parse(attach) : attach;
                const item = Array.isArray(parsed) ? parsed[0] : parsed;
                if (item && typeof item === 'object') {
                    const url = DatabaseService.extractImageUrlFromContent(item) || DatabaseService.extractImageUrlFromContent(item.data);
                    if (url) return url;
                }
            } catch {}
        }
        // 2. Thử msg
        const msgObj: any = (msg && typeof msg === 'string' && msg !== '' && msg !== 'null')
            ? (() => { try { return JSON.parse(msg); } catch { return null; } })()
            : (msg && typeof msg === 'object' ? msg : null);

        if (msgObj && typeof msgObj === 'object') {
            const action = String(msgObj.action || '');
            // Parse params để lấy hd/rawUrl
            let p: any = msgObj.params;
            if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
            if (p?.hd || p?.rawUrl) return p.hd || p.rawUrl;
            // Link preview: chỉ dùng thumb (thumbnail), KHÔNG dùng href (URL trang web)
            if (action === 'recommened.link' || action === 'recommended.link') {
                return String(msgObj.thumb || '');
            }
            // Các loại khác: chỉ trả href nếu trông như ảnh CDN
            const hrefUrl = String(msgObj.href || '');
            if (hrefUrl && isImageUrl(hrefUrl)) return hrefUrl;
            return String(msgObj.thumb || '');
        }
        return '';
    }

    public getDbPath(): string {
        return this.dbPath;
    }

    // ─── Link Operations ──────────────────────────────────────────────

    public saveLink(ownerZaloId: string, threadId: string, msgId: string, url: string, title: string, domain: string, thumbUrl: string, timestamp: number): void {
        if (!this.initialized) return;
        try {
            this.run(
                'INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)',
                [ownerZaloId, threadId, msgId, url, title, domain, thumbUrl, timestamp]
            );
        } catch (err: any) {
            Logger.warn(`[DatabaseService] saveLink error: ${err.message}`);
        }
    }

    public getLinks(ownerZaloId: string, threadId: string, limit = 50, offset = 0): any[] {
        if (!this.initialized) return [];
        // Migrate links table if missing (for existing DBs)
        try {
            const tables = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='links'`);
            if (tables.length === 0) {
                db!.exec(`CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_zalo_id TEXT NOT NULL, thread_id TEXT NOT NULL, msg_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT DEFAULT '', domain TEXT DEFAULT '', thumb_url TEXT DEFAULT '', timestamp INTEGER NOT NULL, UNIQUE(owner_zalo_id, msg_id))`);
                db!.exec(`CREATE INDEX IF NOT EXISTS idx_links_thread ON links(owner_zalo_id, thread_id, timestamp)`);
                this.save();
            }
        } catch {}

        // Bù link từ tin cũ (dữ liệu có trước bảng links): 1 lần / hội thoại / phiên — tin mới lưu link ngay lúc nhận
        // (saveLink, saveFBMessage). Trước đây chạy mỗi lần mở tab Link: hội thoại chưa có link quét lại cả hội thoại, và
        // truy vấn tin Facebook quét hết tin của hội thoại Zalo / Telegram (không bao giờ khớp) — 113k tin ≈ 0,7 s.
        const backfillKey = `${this.dbPath}|${ownerZaloId}|${threadId}`;
        if (!linksBackfilledThreads.has(backfillKey)) {
            linksBackfilledThreads.add(backfillKey);
            this.backfillThreadLinks(ownerZaloId, threadId);
        }

        return this.query(
            'SELECT * FROM links WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
            [ownerZaloId, threadId, limit, offset]
        );
    }

    /** getLinks: bù bảng links từ tin đã lưu trước khi có bảng (link Zalo chưa có trong bảng; URL trong tin Facebook). */
    private backfillThreadLinks(ownerZaloId: string, threadId: string): void {
        // Backfill from messages table - only if no links exist yet for this thread
        try {
            const existing = this.queryOne<any>(
                'SELECT 1 FROM links WHERE owner_zalo_id = ? AND thread_id = ? LIMIT 1',
                [ownerZaloId, threadId]
            );
            if (!existing) {
                const msgs = this.query<any>(
                    `SELECT msg_id, content, timestamp FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND msg_type IN ('chat.recommended','chat.recommend') ORDER BY timestamp DESC LIMIT 300`,
                    [ownerZaloId, threadId]
                );
                if (msgs.length > 0) {
                    const stmt = db!.prepare(
                        'INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)'
                    );
                    let backfilled = 0;
                    for (const m of msgs) {
                        try {
                            const parsed = JSON.parse(m.content || '{}');
                            if (String(parsed.action || '') === 'recommened.link') {
                                const href = String(parsed.href || parsed.title || '');
                                if (!href) continue;
                                const params = (() => { try { const p = parsed.params; return typeof p === 'string' ? JSON.parse(p) : (p || {}); } catch { return {}; } })();
                                const title = String(params.mediaTitle || parsed.title || href);
                                const domain = String(params.src || '');
                                const thumbUrl = String(parsed.thumb || '');
                                stmt.run(ownerZaloId, threadId, m.msg_id, href, title, domain, thumbUrl, m.timestamp);
                                backfilled++;
                            }
                        } catch {}
                    }
                    if (backfilled > 0) this.save();
                }
            }
        } catch {}

        // Bù từ tin Facebook có URL — chỉ hội thoại Facebook (tin mới nhất là tin Facebook)
        try {
            const newest = this.queryOne<{ channel: string | null }>(
                'SELECT channel FROM messages WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT 1',
                [ownerZaloId, threadId]
            );
            if (newest?.channel !== 'facebook') return;
            const fbMsgs = this.query<any>(
                `SELECT msg_id, content, timestamp FROM messages
                 WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook'
                   AND msg_type = 'text' AND content IS NOT NULL
                 ORDER BY timestamp DESC LIMIT 500`,
                [ownerZaloId, threadId]
            );
            if (fbMsgs.length > 0) {
                const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
                const stmt = db!.prepare(
                    'INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)'
                );
                let backfilled = 0;
                for (const m of fbMsgs) {
                    const text = m.content || '';
                    const matches = text.match(urlRegex);
                    if (!matches) continue;
                    for (const url of matches) {
                        try {
                            const domain = new URL(url).hostname;
                            stmt.run(ownerZaloId, threadId, m.msg_id + '_' + url.slice(0, 20), url, url, domain, '', m.timestamp);
                            backfilled++;
                        } catch {}
                    }
                }
                if (backfilled > 0) this.save();
            }
        } catch {}
    }

    // ─── Group Member Cache ───────────────────────────────────────────────

    public saveGroupMembers(
        ownerZaloId: string,
        groupId: string,
        members: Array<{ memberId: string; displayName: string; avatar: string; role: number; username?: string }>
    ): void {
        if (!this.initialized) return;
        const now = Date.now();
        const stmt = db!.prepare(GROUP_MEMBER_UPSERT_SQL);
        // 1 transaction cho cả danh sách (nhóm vài nghìn thành viên: mỗi lệnh tự commit chặn main lâu hơn nhiều lần)
        db!.transaction(() => {
            for (const m of members) {
                stmt.run(ownerZaloId, groupId, m.memberId, m.displayName || '', m.avatar || '', m.role || 0, m.username || '', now);
            }
        })();
        this.save();
        Logger.log(`[DB] Saved ${members.length} group members for group ${groupId}`);
    }

    /** Insert or update a SINGLE group member without touching others */
    public upsertGroupMember(
        ownerZaloId: string,
        groupId: string,
        member: { memberId: string; displayName: string; avatar: string; role: number; username?: string }
    ): void {
        if (!this.initialized) return;
        db!.prepare(GROUP_MEMBER_UPSERT_SQL)
            .run(ownerZaloId, groupId, member.memberId, member.displayName || '', member.avatar || '', member.role || 0, member.username || '', Date.now());
        this.save();
        // Individual member hydration is expected during Telegram catch-up;
        // emitting one line per member makes the Electron log unusable.
        // Logger.log(`[DB] Upserted member ${member.memberId} role=${member.role} in group ${groupId}`);
    }

    /** Remove a SINGLE group member from DB */
    public removeGroupMember(ownerZaloId: string, groupId: string, memberId: string): void {
        if (!this.initialized) return;
        db!.prepare(
            `DELETE FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`
        ).run(ownerZaloId, groupId, memberId);
        this.save();
        Logger.log(`[DB] Removed member ${memberId} from group ${groupId}`);
    }

    public getGroupMembers(ownerZaloId: string, groupId: string): Array<{
        member_id: string;
        display_name: string;
        avatar: string;
        role: number;
        username: string;
        updated_at: number;
    }> {
        if (!this.initialized) return [];
        return this.query<any>(
            `SELECT member_id, display_name, avatar, role, username, updated_at
             FROM page_group_member
             WHERE owner_zalo_id = ? AND group_id = ?
             ORDER BY role DESC`,
            [ownerZaloId, groupId]
        );
    }

    /** Kết nối đã có hàm SQL `deplao_fold` (DB chính và DB phụ của withDbPath là các kết nối khác nhau). */
    private static readonly foldFunctionDbs = new WeakSet<object>();

    /** Hàm SQL `deplao_fold(text)`: bỏ dấu tiếng Việt + chữ thường (foldSearchText) — tìm / sắp xếp tên thành viên. */
    private ensureFoldFunction(): void {
        if (!db || DatabaseService.foldFunctionDbs.has(db)) return;
        db.function('deplao_fold', { deterministic: true }, (value: unknown) => foldSearchText(value));
        DatabaseService.foldFunctionDbs.add(db);
    }

    /**
     * Một trang thành viên nhóm (panel "Thành viên" của khung chat) — đủ mọi thành viên đã có trong DB: quét thành viên
     * ẩn, thu thập từ lịch sử tin Telegram, đồng bộ API. Tìm theo tên / @username / id, không phân biệt dấu và hoa /
     * thường. Thứ tự cố định để phân trang: chủ nhóm, phó nhóm / quản trị, thành viên; người có tên trước người chỉ có
     * id; rồi theo tên. `ownerRole` = giá trị role của chủ nhóm theo kênh (Zalo 2, Telegram 1 — shared/chat/groupMemberRoles).
     * @username: của hàng, hàng chưa có thì lấy @username Telegram đã biết của người đó (telegram_peers). `namedOnly`: bỏ
     * người chưa có tên (chỉ có id) — ô @nhắc đến.
     */
    public getGroupMembersPage(
        ownerZaloId: string,
        groupId: string,
        options: { query?: string; limit?: number; offset?: number; ownerRole?: number; namedOnly?: boolean } = {},
    ): {
        members: Array<{ member_id: string; display_name: string; avatar: string; role: number; username: string; updated_at: number }>;
        total: number;
    } {
        if (!this.initialized || !ownerZaloId || !groupId) return { members: [], total: 0 };
        this.ensureFoldFunction();
        const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 50), 1), 500);
        const offset = Math.max(Math.floor(Number(options.offset) || 0), 0);
        const ownerRole = Number(options.ownerRole) === 1 ? 1 : 2;
        const { join, username } = this.groupMemberSource();
        // Id thành viên chỉ gồm chữ số (bỏ rác của các lần parse lỗi cũ như "profiles") — như CRM Nhóm
        const conditions = [`gm.owner_zalo_id = ?`, `gm.group_id = ?`, `gm.member_id GLOB '[0-9]*'`, `gm.member_id NOT GLOB '*[^0-9]*'`];
        const params: unknown[] = [ownerZaloId, groupId];
        if (options.namedOnly) conditions.push(`TRIM(COALESCE(gm.display_name, '')) <> ''`, `gm.display_name <> gm.member_id`);
        const query = foldSearchText(options.query);
        if (query) {
            const like = `%${escapeLikePattern(query)}%`;
            conditions.push(`(deplao_fold(gm.display_name) LIKE ? ESCAPE '\\' OR deplao_fold(${username}) LIKE ? ESCAPE '\\' OR gm.member_id LIKE ? ESCAPE '\\')`);
            params.push(like, like, like);
        }
        const where = conditions.join(' AND ');
        const columns = `gm.member_id, gm.display_name, gm.avatar, gm.role, ${username} AS username, gm.updated_at`;
        const order = `ORDER BY CASE WHEN gm.role = ? THEN 0 WHEN gm.role > 0 THEN 1 ELSE 2 END,
                      CASE WHEN TRIM(COALESCE(gm.display_name, '')) = '' OR gm.display_name = gm.member_id THEN 1 ELSE 0 END,
                      deplao_fold(gm.display_name), gm.member_id`;
        if (query) {
            // Tìm theo @username: điều kiện cần telegram_peers của mọi hàng
            const total = Number(this.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM page_group_member gm ${join} WHERE ${where}`, params)?.n || 0);
            const members = this.query<any>(
                `SELECT ${columns} FROM page_group_member gm ${join} WHERE ${where} ${order} LIMIT ? OFFSET ?`,
                [...params, ownerRole, limit, offset],
            );
            return { members, total };
        }
        // Không tìm: đếm, xếp, cắt trang chỉ trên page_group_member; @username chỉ lấy cho các hàng của trang. JOIN theo khoá
        // chính nên không đổi số hàng, xếp lại cùng khoá (member_id duy nhất trong nhóm) nên đúng thứ tự cũ. Nhóm 5k người:
        // đếm 8 → 0,7 ms, trang 28 → 12 ms (phần còn lại là deplao_fold của từng tên).
        const total = Number(this.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM page_group_member gm WHERE ${where}`, params)?.n || 0);
        const members = this.query<any>(
            `SELECT ${columns}
             FROM (SELECT * FROM page_group_member gm WHERE ${where} ${order} LIMIT ? OFFSET ?) gm ${join}
             ${order}`,
            [...params, ownerRole, limit, offset, ownerRole],
        );
        return { members, total };
    }

    /**
     * @username của thành viên nhóm (`gm` = page_group_member): của hàng, thiếu thì @username Telegram đã biết của người đó
     * (`join` nối telegram_peers — lưu mỗi lần gặp người đó ở bất kỳ đâu, kể cả trước khi page_group_member giữ @username).
     */
    private groupMemberSource(): { join: string; username: string } {
        if (!this.hasTable('telegram_peers')) return { join: '', username: `COALESCE(gm.username, '')` };
        return {
            join: 'LEFT JOIN telegram_peers tp ON tp.owner_zalo_id = gm.owner_zalo_id AND tp.peer_id = gm.member_id',
            username: `COALESCE(NULLIF(gm.username, ''), tp.username, '')`,
        };
    }

    /** Bảng có trong DB đang dùng không — nhớ theo từng kết nối (DB chính và DB phụ của withDbPath khác nhau). */
    private static readonly knownTables = new WeakMap<object, Map<string, boolean>>();

    private hasTable(name: string): boolean {
        if (!db) return false;
        let tables = DatabaseService.knownTables.get(db);
        if (!tables) {
            tables = new Map();
            DatabaseService.knownTables.set(db, tables);
        }
        let exists = tables.get(name);
        if (exists === undefined) {
            exists = !!this.queryOne<{ ok: number }>(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);
            tables.set(name, exists);
        }
        return exists;
    }

    /** Lấy tất cả thành viên nhóm cho tất cả các nhóm của một tài khoản (bulk load) */
    public getAllGroupMembers(ownerZaloId: string): Array<{
        group_id: string;
        member_id: string;
        display_name: string;
        avatar: string;
        role: number;
        updated_at: number;
    }> {
        if (!this.initialized) return [];
        return this.query<any>(
            `SELECT group_id, member_id, display_name, avatar, role, updated_at
             FROM page_group_member
             WHERE owner_zalo_id = ?
             ORDER BY group_id, role DESC`,
            [ownerZaloId]
        );
    }

    // ─── Sticker Cache (device-wide) ─────────────────────────────────────

    /** Lưu danh sách sticker vào cache DB */
    public saveStickers(stickers: any[]): void {
        if (!this.initialized || !stickers?.length) return;
        try {
            const stmt = db!.prepare(
                `INSERT OR REPLACE INTO stickers
                 (sticker_id, cat_id, type, text, sticker_url, sticker_sprite_url, checksum, data_json, unsupported, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`
            );
            const now = Date.now();
            for (const s of stickers) {
                try {
                    stmt.run(
                        s.id,
                        s.cateId ?? s.catId ?? 0,
                        s.type ?? 0,
                        s.text ?? '',
                        s.stickerUrl ?? '',
                        s.stickerSpriteUrl ?? '',
                        s.checksum ?? '',
                        JSON.stringify(s),
                        0,
                        now,
                    );
                } catch (err: any) {
                    Logger.warn(`[DB] saveStickers skip id=${s?.id}: ${err.message}`);
                }
            }
            this.save();
        } catch (err: any) {
            Logger.warn(`[DB] saveStickers error: ${err.message}`);
        }
    }

    /** Lấy sticker theo ID từ cache DB (bao gồm cờ unsupported) */
    public getStickerById(stickerId: number): any | undefined {
        if (!this.initialized) return undefined;
        const row = this.queryOne<any>(`SELECT data_json, unsupported FROM stickers WHERE sticker_id = ?`, [stickerId]);
        if (!row) return undefined;
        try {
            const data = JSON.parse(row.data_json);
            if (data) data._unsupported = row.unsupported === 1;
            return data;
        } catch { return undefined; }
    }

    /** Đánh dấu sticker là không hỗ trợ (tránh gọi API lại) */
    public markStickerUnsupported(stickerId: number): void {
        if (!this.initialized) return;
        // Nếu sticker chưa tồn tại, tạo bản ghi tối thiểu
        this.run(
            `INSERT OR IGNORE INTO stickers (sticker_id, unsupported, data_json, updated_at) VALUES (?,1,'{}',?)`,
            [stickerId, Date.now()]
        );
        this.run(
            `UPDATE stickers SET unsupported = 1, updated_at = ? WHERE sticker_id = ?`,
            [Date.now(), stickerId]
        );
    }

    /** Kiểm tra sticker có bị đánh dấu unsupported không */
    public isStickerUnsupported(stickerId: number): boolean {
        if (!this.initialized) return false;
        const row = this.queryOne<any>(`SELECT unsupported FROM stickers WHERE sticker_id = ?`, [stickerId]);
        return row?.unsupported === 1;
    }

    // ─── Sticker Packs ───────────────────────────────────────────────────

    /** Lưu sticker packs vào DB */
    public saveStickerPacks(packs: any[]): void {
        if (!this.initialized || !packs?.length) return;
        try {
            const stmt = db!.prepare(
                `INSERT OR REPLACE INTO sticker_packs
                 (cat_id, name, thumb_url, sticker_count, data_json, updated_at)
                 VALUES (?,?,?,?,?,?)`
            );
            const now = Date.now();
            for (const p of packs) {
                try {
                    stmt.run(
                        p.catId ?? p.cat_id ?? 0,
                        p.name ?? '',
                        p.thumbUrl ?? p.thumb_url ?? '',
                        p.stickerCount ?? p.sticker_count ?? 0,
                        JSON.stringify(p),
                        now,
                    );
                } catch (err: any) {
                    Logger.warn(`[DB] saveStickerPacks skip catId=${p?.catId}: ${err.message}`);
                }
            }
            this.save();
        } catch (err: any) {
            Logger.warn(`[DB] saveStickerPacks error: ${err.message}`);
        }
    }

    /** Lấy tất cả sticker packs đã cache */
    public getStickerPacks(): any[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT data_json, updated_at FROM sticker_packs ORDER BY updated_at DESC`
        );
        return rows.map((r) => {
            try {
                const data = JSON.parse(r.data_json);
                data._updatedAt = r.updated_at;
                return data;
            } catch { return null; }
        }).filter(Boolean);
    }

    /** Lấy tất cả sticker thuộc một pack (catId) */
    public getStickersByPackId(catId: number): any[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT data_json, unsupported FROM stickers WHERE cat_id = ? AND unsupported = 0 ORDER BY sticker_id`,
            [catId]
        );
        return rows.map((r) => {
            try { return JSON.parse(r.data_json); } catch { return null; }
        }).filter(Boolean);
    }

    /** Lấy danh sách sticker gần dùng (kèm đầy đủ thông tin) */
    public getRecentStickers(limit: number = 30): any[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT s.data_json
             FROM stickers s
             INNER JOIN recent_stickers rs ON rs.sticker_id = s.sticker_id
             ORDER BY rs.used_at DESC
             LIMIT ?`,
            [limit]
        );
        return rows.map((r) => { try { return JSON.parse(r.data_json); } catch { return null; } }).filter(Boolean);
    }

    /** Thêm/cập nhật sticker vào danh sách gần dùng */
    public addRecentSticker(stickerId: number): void {
        if (!this.initialized) return;
        this.runNoSave(
            `INSERT OR REPLACE INTO recent_stickers (sticker_id, used_at) VALUES (?,?)`,
            [stickerId, Date.now()]
        );
        // Giữ tối đa 50 sticker gần dùng
        this.runNoSave(
            `DELETE FROM recent_stickers WHERE sticker_id NOT IN (
               SELECT sticker_id FROM recent_stickers ORDER BY used_at DESC LIMIT 50
             )`
        );
        this.save();
    }

    // ─── Keyword → Sticker IDs Cache ──────────────────────────────────────

    /** Lưu keyword → stickerIds mapping */
    public saveKeywordStickers(keyword: string, stickerIds: number[]): void {
        if (!this.initialized || !keyword) return;
        try {
            this.run(
                `INSERT OR REPLACE INTO keyword_stickers (keyword, sticker_ids, updated_at) VALUES (?,?,?)`,
                [keyword.toLowerCase().trim(), JSON.stringify(stickerIds), Date.now()]
            );
        } catch (err: any) {
            Logger.warn(`[DB] saveKeywordStickers error: ${err.message}`);
        }
    }

    /** Lấy stickerIds theo keyword (null nếu chưa cache) */
    public getKeywordStickers(keyword: string): number[] | null {
        if (!this.initialized || !keyword) return null;
        const row = this.queryOne<any>(
            `SELECT sticker_ids, updated_at FROM keyword_stickers WHERE keyword = ?`,
            [keyword.toLowerCase().trim()]
        );
        if (!row) return null;
        try {
            return JSON.parse(row.sticker_ids);
        } catch { return null; }
    }

    /** Lấy sticker details theo danh sách IDs từ bảng stickers */
    public getStickersByIds(stickerIds: number[]): any[] {
        if (!this.initialized || !stickerIds?.length) return [];
        // SQLite placeholders
        const placeholders = stickerIds.map(() => '?').join(',');
        const rows = this.query<any>(
            `SELECT data_json FROM stickers WHERE sticker_id IN (${placeholders}) AND unsupported = 0`,
            stickerIds
        );
        return rows.map((r) => {
            try { return JSON.parse(r.data_json); } catch { return null; }
        }).filter(Boolean);
    }

    /** Lấy tất cả cat_id có sticker trong cache (để build store từ DB) */
    public getAllCachedPackSummaries(): { catId: number; count: number; thumbUrl: string }[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT cat_id, COUNT(*) as cnt,
                    (SELECT sticker_url FROM stickers s2 WHERE s2.cat_id = s.cat_id AND s2.sticker_url != '' LIMIT 1) as thumb
             FROM stickers s
             WHERE cat_id > 0 AND unsupported = 0
             GROUP BY cat_id
             HAVING cnt >= 1
             ORDER BY MAX(updated_at) DESC`
        );
        return rows.map((r: any) => ({
            catId: r.cat_id,
            count: r.cnt,
            thumbUrl: r.thumb || '',
        }));
    }

    // ─── Pinned Messages ──────────────────────────────────────────────────────

    /** Lấy danh sách tin ghim (mới nhất trước) */
    public getPinnedMessages(ownerZaloId: string, threadId: string): any[] {
        if (!this.initialized) return [];
        return this.query<any>(
            `SELECT * FROM pinned_messages WHERE owner_zalo_id=? AND thread_id=? ORDER BY pinned_at DESC`,
            [ownerZaloId, threadId]
        );
    }

    /** Ghim một tin nhắn */
    public pinMessage(ownerZaloId: string, threadId: string, pin: {
        msgId: string; msgType: string; content: string;
        previewText: string; previewImage: string;
        senderId: string; senderName: string; timestamp: number;
        /** Remote channels can provide the message time, which is the only
         * stable ordering field when their API does not expose pin time. */
        pinnedAt?: number;
    }): void {
        if (!this.initialized) return;
        this.run(
            `INSERT OR REPLACE INTO pinned_messages
             (owner_zalo_id, thread_id, msg_id, msg_type, content, preview_text, preview_image, sender_id, sender_name, timestamp, pinned_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [ownerZaloId, threadId, pin.msgId, pin.msgType, pin.content,
             pin.previewText, pin.previewImage, pin.senderId, pin.senderName,
             pin.timestamp, pin.pinnedAt || Date.now()]
        );
    }

    /** Replace Telegram's remote pin snapshot while preserving local note pins. */
    public replaceRemotePinnedMessages(ownerZaloId: string, threadId: string, pins: Array<{
        msgId: string; msgType: string; content: string;
        previewText: string; previewImage: string;
        senderId: string; senderName: string; timestamp: number; pinnedAt?: number;
    }>): void {
        if (!this.initialized) return;
        this.transaction(() => {
            this.run(
                `DELETE FROM pinned_messages
                 WHERE owner_zalo_id=? AND thread_id=? AND msg_type <> 'note'`,
                [ownerZaloId, threadId]
            );
            for (const pin of pins) this.pinMessage(ownerZaloId, threadId, pin);
        });
    }

    /** Bỏ ghim một tin nhắn */
    public unpinMessage(ownerZaloId: string, threadId: string, msgId: string): void {
        if (!this.initialized) return;
        this.run(
            `DELETE FROM pinned_messages WHERE owner_zalo_id=? AND thread_id=? AND msg_id=?`,
            [ownerZaloId, threadId, msgId]
        );
    }

    /** Đưa tin ghim lên đầu (cập nhật pinned_at về now) */
    public bringPinnedToTop(ownerZaloId: string, threadId: string, msgId: string): void {
        if (!this.initialized) return;
        this.run(
            `UPDATE pinned_messages SET pinned_at=? WHERE owner_zalo_id=? AND thread_id=? AND msg_id=?`,
            [Date.now(), ownerZaloId, threadId, msgId]
        );
    }

    /** Lấy tin nhắn theo msg_type trong một thread (mới nhất trước) */
    public getMessagesByType(ownerZaloId: string, threadId: string, msgType: string, limit: number = 100): any[] {
        if (!this.initialized) return [];
        return this.query<any>(
            `SELECT * FROM messages WHERE owner_zalo_id=? AND thread_id=? AND msg_type=? AND is_recalled=0
             ORDER BY timestamp DESC LIMIT ?`,
            [ownerZaloId, threadId, msgType, limit]
        );
    }

    // ─── Local Quick Messages ──────────────────────────────────────────────

    /** Lấy toàn bộ tin nhắn nhanh local theo zaloId */
    public getLocalQuickMessages(ownerZaloId: string): any[] {
        if (!this.initialized) return [];
        const rows = this.query<any>(
            `SELECT * FROM local_quick_messages WHERE owner_zalo_id=? ORDER BY keyword ASC`,
            [ownerZaloId]
        );
        return rows.map(r => ({
            id: r.id,
            keyword: r.keyword,
            title: r.title,
            media: r.media_json ? JSON.parse(r.media_json) : null,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }));
    }

    /** Upsert một tin nhắn nhanh local */
    public upsertLocalQuickMessage(ownerZaloId: string, item: { keyword: string; title: string; media?: any }): number {
        if (!this.initialized) return 0;
        const now = Date.now();
        const existing = this.queryOne<any>(
            `SELECT id FROM local_quick_messages WHERE owner_zalo_id=? AND keyword=?`,
            [ownerZaloId, item.keyword]
        );
        if (existing) {
            this.run(
                `UPDATE local_quick_messages SET title=?, media_json=?, updated_at=? WHERE owner_zalo_id=? AND keyword=?`,
                [item.title, item.media ? JSON.stringify(item.media) : null, now, ownerZaloId, item.keyword]
            );
            return existing.id;
        } else {
            this.run(
                `INSERT INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
                [ownerZaloId, item.keyword, item.title, item.media ? JSON.stringify(item.media) : null, now, now]
            );
            const row = this.queryOne<any>(
                `SELECT id FROM local_quick_messages WHERE owner_zalo_id=? AND keyword=?`,
                [ownerZaloId, item.keyword]
            );
            return row?.id || 0;
        }
    }

    /** Xóa tin nhắn nhanh local theo id */
    public deleteLocalQuickMessage(ownerZaloId: string, id: number): void {
        if (!this.initialized) return;
        this.run(`DELETE FROM local_quick_messages WHERE owner_zalo_id=? AND id=?`, [ownerZaloId, id]);
    }

    /** Xóa tất cả và upsert lại toàn bộ (dùng khi sync từ Zalo) */
    public bulkReplaceLocalQuickMessages(ownerZaloId: string, items: Array<{ keyword: string; title: string; media?: any }>): void {
        if (!this.initialized) return;
        this.runNoSave(`DELETE FROM local_quick_messages WHERE owner_zalo_id=?`, [ownerZaloId]);
        const now = Date.now();
        const stmt = db!.prepare(
            `INSERT OR REPLACE INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`
        );
        for (const item of items) {
            stmt.run(ownerZaloId, item.keyword, item.title, item.media ? JSON.stringify(item.media) : null, now, now);
        }
        this.save();
    }

    /** Clone toàn bộ local quick messages từ một account sang account khác */
    public cloneLocalQuickMessages(sourceZaloId: string, targetZaloId: string): number {
        if (!this.initialized) return 0;
        try {
            const rows = this.query<any>(
                `SELECT keyword, title, media_json FROM local_quick_messages WHERE owner_zalo_id=? ORDER BY keyword ASC`,
                [sourceZaloId]
            );
            if (rows.length === 0) return 0;
            const now = Date.now();
            const stmt = db!.prepare(
                `INSERT OR REPLACE INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at)
                 VALUES (?,?,?,?,?,?)`
            );
            let count = 0;
            for (const row of rows) {
                try {
                    stmt.run(targetZaloId, row.keyword, row.title, row.media_json, now, now);
                    count++;
                } catch {}
            }
            this.save();
            return count;
        } catch (err: any) {
            Logger.error(`[DB] cloneLocalQuickMessages: ${err.message}`);
            return 0;
        }
    }

    /** Clone labels assigned to sourceZaloId to targetZaloId.
     *  Since labels are stored with comma-separated 'page_ids', this means appending targetZaloId to relevant labels.
     */
    public cloneLocalLabels(sourceZaloId: string, targetZaloId: string): number {
        if (!this.initialized) return 0;

        let count = 0;

        try {
            const labels = this.query<any>(
                `SELECT * FROM local_labels WHERE page_ids LIKE ?`,
                [`%${sourceZaloId}%`]
            );

            for (const label of labels) {
                const pids = (label.page_ids || '').split(',').filter(Boolean);

                // 👉 Nếu đã có target → bỏ qua
                if (pids.includes(targetZaloId)) continue;

                // 👉 Check target đã có label cùng name chưa
                const existed = this.queryOne<any>(
                    `SELECT * FROM local_labels
                 WHERE name = ?
                 AND page_ids LIKE ?
                 LIMIT 1`,
                    [label.name, `%${targetZaloId}%`]
                );

                if (existed) continue;

                // 👉 thêm target vào label hiện tại
                pids.push(targetZaloId);
                const newIds = pids.join(',');

                this.runNoSave(
                    `UPDATE local_labels SET page_ids=?, updated_at=? WHERE id=?`,
                    [newIds, Date.now(), label.id]
                );

                count++;
            }

            if (count > 0) this.save();

            return count;
        } catch (err: any) {
            Logger.error(`[DB] cloneLocalLabels: ${err.message}`);
            return 0;
        }
    }


    /** Lấy toàn bộ quick messages của TẤT CẢ accounts - dùng cho Settings global list */
    public getAllLocalQuickMessages(): any[] {
        if (!this.initialized) return [];
        try {
            const rows = this.query<any>(`SELECT * FROM local_quick_messages ORDER BY owner_zalo_id ASC, sort_order ASC, keyword ASC`);
            return rows.map((r: any) => {
                const mediaObj = r.media_json ? JSON.parse(r.media_json) : null;
                const localFiles: any[] | undefined = mediaObj?.localFiles?.length ? mediaObj.localFiles : undefined;
                return {
                    id: r.id,
                    owner_zalo_id: r.owner_zalo_id,
                    keyword: r.keyword,
                    message: { title: r.title },
                    media: localFiles ? null : mediaObj,
                    _local: true,
                    _localMedia: localFiles,
                    is_active: r.is_active ?? 1,
                    sort_order: r.sort_order ?? 0,
                    createdAt: r.created_at,
                    updatedAt: r.updated_at,
                };
            });
        } catch (err: any) {
            Logger.error(`[DB] getAllLocalQuickMessages: ${err.message}`);
            return [];
        }
    }

    /** Bật/tắt trạng thái hoạt động của một quick message */
    public setLocalQMActive(id: number, isActive: number): void {
        if (!this.initialized) return;
        this.run(`UPDATE local_quick_messages SET is_active=?, updated_at=? WHERE id=?`, [isActive, Date.now(), id]);
    }

    /** Cập nhật sort_order của một quick message */
    public setLocalQMOrder(id: number, sortOrder: number): void {
        if (!this.initialized) return;
        this.run(`UPDATE local_quick_messages SET sort_order=?, updated_at=? WHERE id=?`, [sortOrder, Date.now(), id]);
    }

    // ─── Local Labels ──────────────────────────────────────────────────────────

    /** Lấy tất cả local labels.
     *  Nếu zaloId được cung cấp → chỉ trả về labels áp dụng cho account đó (page_ids rỗng = global). */
    public getLocalLabels(zaloId?: string): any[] {
        if (!this.initialized) return [];
        try {
            if (!zaloId) {
                return this.query<any>(`SELECT * FROM local_labels ORDER BY sort_order ASC, name ASC`);
            }
            return this.query<any>(
                `SELECT * FROM local_labels WHERE page_ids = '' OR page_ids LIKE ? ORDER BY sort_order ASC, name ASC`,
                [`%${zaloId}%`]
            );
        } catch (err: any) {
            Logger.error(`[DB] getLocalLabels: ${err.message}`);
            return [];
        }
    }

    /** Tạo hoặc cập nhật một local label. Trả về id */
    public upsertLocalLabel(label: {
        id?: number;
        name: string;
        color: string;
        textColor?: string;
        emoji: string;
        pageIds: string;
        isActive?: number;
        sortOrder?: number;
        shortcut?: string;
    }): number {
        if (!this.initialized) return -1;

        try {
            const now = Date.now();
            const tc = label.textColor || '#FFFFFF';
            const shortcut = label.shortcut || '';

            // 👉 Check trùng name trong từng page_id
            const pageIds = (label.pageIds || '').split(',').filter(Boolean);

            for (const pid of pageIds) {
                const existed = this.queryOne<any>(
                    `SELECT * FROM local_labels
                 WHERE name = ?
                 AND page_ids LIKE ?
                 AND (${label.id ? 'id != ?' : '1=1'})
                 LIMIT 1`,
                    label.id ? [label.name, `%${pid}%`, label.id] : [label.name, `%${pid}%`]
                );

                if (existed) {
                    // đã tồn tại label cùng tên trong page → bỏ qua
                    return existed.id;
                }
            }

            if (label.id) {
                this.run(
                    `UPDATE local_labels
                     SET name=?, color=?, text_color=?, emoji=?, page_ids=?,
                         is_active=COALESCE(?,is_active),
                         sort_order=COALESCE(?,sort_order),
                         shortcut=?,
                         updated_at=?
                     WHERE id=?`,
                    [
                        label.name,
                        label.color,
                        tc,
                        label.emoji,
                        label.pageIds,
                        label.isActive ?? null,
                        label.sortOrder ?? null,
                        shortcut,
                        now,
                        label.id
                    ]
                );
                return label.id;
            } else {
                this.run(
                    `INSERT INTO local_labels
                     (name, color, text_color, emoji, page_ids, is_active, sort_order, shortcut, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [
                        label.name,
                        label.color,
                        tc,
                        label.emoji,
                        label.pageIds,
                        label.isActive ?? 1,
                        label.sortOrder ?? 0,
                        shortcut,
                        now,
                        now
                    ]
                );

                return this.queryOne<any>(`SELECT last_insert_rowid() as id`)?.id ?? -1;
            }
        } catch (err: any) {
            Logger.error(`[DB] upsertLocalLabel: ${err.message}`);
            return -1;
        }
    }

    /** Bật/tắt trạng thái hoạt động của một label */
    public setLocalLabelActive(id: number, isActive: number): void {
        if (!this.initialized) return;
        this.run(`UPDATE local_labels SET is_active=?, updated_at=? WHERE id=?`, [isActive, Date.now(), id]);
    }

    /** Cập nhật sort_order của một label */
    public setLocalLabelOrder(id: number, sortOrder: number): void {
        if (!this.initialized) return;
        this.run(`UPDATE local_labels SET sort_order=?, updated_at=? WHERE id=?`, [sortOrder, Date.now(), id]);
    }

    /** Xóa một local label (cascade xóa assignments) */
    public deleteLocalLabel(id: number): void {
        if (!this.initialized) return;
        try {
            this.runNoSave(`DELETE FROM local_label_threads WHERE label_id=?`, [id]);
            this.runNoSave(`DELETE FROM local_labels WHERE id=?`, [id]);
            this.save();
        } catch (err: any) {
            Logger.error(`[DB] deleteLocalLabel: ${err.message}`);
        }
    }

    /** Lấy tất cả thread assignments của một account */
    public getLocalLabelThreads(ownerZaloId: string): { label_id: number; thread_id: string }[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT label_id, thread_id FROM local_label_threads WHERE owner_zalo_id=?`,
                [ownerZaloId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getLocalLabelThreads: ${err.message}`);
            return [];
        }
    }

    /** Gán label cho một thread */
    public assignLocalLabelToThread(ownerZaloId: string, labelId: number, threadId: string): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT OR IGNORE INTO local_label_threads (owner_zalo_id, label_id, thread_id, created_at) VALUES (?,?,?,?)`,
                [ownerZaloId, labelId, threadId, Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DB] assignLocalLabelToThread: ${err.message}`);
        }
    }

    /** Gán nhiều label cho nhiều thread trong 1 transaction — tối ưu cho bulk */
    public bulkAssignLocalLabelToThread(ownerZaloId: string, labelIds: number[], threadIds: string[]): number {
        if (!this.initialized || !db || labelIds.length === 0 || threadIds.length === 0) return 0;
        let count = 0;
        const now = Date.now();
        try {
            db.exec('BEGIN');
            const stmt = db.prepare(
                `INSERT OR IGNORE INTO local_label_threads (owner_zalo_id, label_id, thread_id, created_at) VALUES (?,?,?,?)`
            );
            for (const labelId of labelIds) {
                for (const threadId of threadIds) {
                    stmt.run(ownerZaloId, labelId, threadId, now);
                    count++;
                }
            }
            db.exec('COMMIT');
        } catch (err: any) {
            try { db!.exec('ROLLBACK'); } catch {}
            Logger.error(`[DB] bulkAssignLocalLabelToThread: ${err.message}`);
        }
        return count;
    }

    /** Gỡ label khỏi một thread */
    public removeLocalLabelFromThread(ownerZaloId: string, labelId: number, threadId: string): void {
        if (!this.initialized) return;
        try {
            this.run(
                `DELETE FROM local_label_threads WHERE owner_zalo_id=? AND label_id=? AND thread_id=?`,
                [ownerZaloId, labelId, threadId]
            );
        } catch (err: any) {
            Logger.error(`[DB] removeLocalLabelFromThread: ${err.message}`);
        }
    }

    /** Lấy tất cả local labels đang được gán cho một thread */
    public getThreadLocalLabels(ownerZaloId: string, threadId: string): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT ll.* FROM local_labels ll
                 INNER JOIN local_label_threads llt ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id=? AND llt.thread_id=?
                 ORDER BY ll.name ASC`,
                [ownerZaloId, threadId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getThreadLocalLabels: ${err.message}`);
            return [];
        }
    }

    // ─── CRM Methods ─────────────────────────────────────────────────────────

    /** Notes */
    public getCRMNotes(ownerZaloId: string, contactId: string): CRMNote[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT * FROM crm_notes WHERE owner_zalo_id=? AND contact_id=? ORDER BY updated_at DESC`, [ownerZaloId, contactId]);
        } catch (err: any) { Logger.error(`[DB] getCRMNotes: ${err.message}`); return []; }
    }

    public saveCRMNote(note: CRMNote): number {
        if (!this.initialized) return 0;
        try {
            const now = Date.now();
            const contactType = note.contact_type ?? 'user';
            const topicId = note.topic_id ?? null;
            if (note.id) {
                this.run(
                    `UPDATE crm_notes SET content=?, topic_id=?, updated_at=? WHERE id=? AND owner_zalo_id=?`,
                    [note.content, topicId, now, note.id, note.owner_zalo_id],
                );
                return note.id;
            } else {
                return this.runInsert(
                    `INSERT INTO crm_notes (owner_zalo_id, contact_id, contact_type, content, topic_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
                    [note.owner_zalo_id, note.contact_id, contactType, note.content, topicId, now, now],
                );
            }
        } catch (err: any) { Logger.error(`[DB] saveCRMNote: ${err.message}`); return 0; }
    }

    /** Cập nhật topicId cho một ghi chú nhóm sau khi API trả về */
    public setNoteTopicId(noteId: number, ownerZaloId: string, topicId: string): void {
        if (!this.initialized) return;
        try {
            this.run(`UPDATE crm_notes SET topic_id=? WHERE id=? AND owner_zalo_id=?`, [topicId, noteId, ownerZaloId]);
        } catch (err: any) { Logger.error(`[DB] setNoteTopicId: ${err.message}`); }
    }

    public deleteCRMNote(noteId: number, ownerZaloId: string): void {
        if (!this.initialized) return;
        try { this.run(`DELETE FROM crm_notes WHERE id=? AND owner_zalo_id=?`, [noteId, ownerZaloId]); }
        catch (err: any) { Logger.error(`[DB] deleteCRMNote: ${err.message}`); }
    }

    /** Campaigns */
    public getCRMCampaigns(ownerZaloId: string): CRMCampaign[] {
        if (!this.initialized) return [];
        try {
            // sent_at là milliseconds → so sánh với đầu ngày hôm nay (ms)
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const todayStartMs = todayStart.getTime();
            return this.query<any>(
                `SELECT c.*,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id) as total_contacts,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='sent') as sent_count,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='pending') as pending_count,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='failed') as failed_count,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='sent' AND cc.sent_at >= ?) as sent_today_count
                 FROM crm_campaigns c WHERE c.owner_zalo_id=? ORDER BY c.created_at DESC`,
                [todayStartMs, ownerZaloId]
            );
        } catch (err: any) { Logger.error(`[DB] getCRMCampaigns: ${err.message}`); return []; }
    }

    public getCRMCampaign(campaignId: number): CRMCampaign | null {
        if (!this.initialized) return null;
        try {
            const rows = this.query<any>(`SELECT * FROM crm_campaigns WHERE id=?`, [campaignId]);
            return rows[0] || null;
        } catch (err: any) { Logger.error(`[DB] getCRMCampaign: ${err.message}`); return null; }
    }

    public saveCRMCampaign(campaign: CRMCampaign): number {
        if (!this.initialized) return 0;
        try {
            const now = Date.now();
            const type = campaign.campaign_type || 'message';
            const channel = campaign.channel || this.queryOne<{ channel?: string }>('SELECT channel FROM accounts WHERE zalo_id=?', [campaign.owner_zalo_id])?.channel || 'zalo';
            const frMsg = campaign.friend_request_message || '';
            const status = campaign.status || 'draft';
            const mixedCfg = campaign.mixed_config || '{}';
            const dailyLimit = campaign.daily_send_limit ?? 0;
            const dailyStartTime = campaign.daily_start_time || '08:00';
            // Delay range fields (with backward compat)
            const delayMin = campaign.delay_min_seconds ?? Math.max(30, (campaign.delay_seconds || 60) - 10);
            const delayMax = campaign.delay_max_seconds ?? Math.max(delayMin, (campaign.delay_seconds || 60) + 10);
            const perContactMin = campaign.per_contact_delay_min_seconds ?? 0;
            const perContactMax = campaign.per_contact_delay_max_seconds ?? perContactMin;
            // Still write delay_seconds as the midpoint for backward compat
            const compatDelaySeconds = campaign.delay_seconds || Math.round((delayMin + delayMax) / 2);
            if (campaign.id) {
                this.run(
                    `UPDATE crm_campaigns SET channel=?, name=?, template_message=?, friend_request_message=?, campaign_type=?, mixed_config=?, status=?, delay_seconds=?, delay_min_seconds=?, delay_max_seconds=?, per_contact_delay_min_seconds=?, per_contact_delay_max_seconds=?, daily_send_limit=?, daily_start_time=?, updated_at=? WHERE id=? AND owner_zalo_id=?`,
                    [channel, campaign.name, campaign.template_message || '', frMsg, type, mixedCfg, status, compatDelaySeconds, delayMin, delayMax, perContactMin, perContactMax, dailyLimit, dailyStartTime, now, campaign.id, campaign.owner_zalo_id]
                );
                return campaign.id;
            } else {
                return this.runInsert(
                    `INSERT INTO crm_campaigns (owner_zalo_id, channel, name, template_message, friend_request_message, campaign_type, mixed_config, status, delay_seconds, delay_min_seconds, delay_max_seconds, per_contact_delay_min_seconds, per_contact_delay_max_seconds, daily_send_limit, daily_start_time, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [campaign.owner_zalo_id, channel, campaign.name, campaign.template_message, frMsg, type, mixedCfg, campaign.status || 'draft', compatDelaySeconds, delayMin, delayMax, perContactMin, perContactMax, dailyLimit, dailyStartTime, now, now]
                );
            }
        } catch (err: any) { Logger.error(`[DB] saveCRMCampaign: ${err.message}`); return 0; }
    }

    public updateCRMCampaignStatus(campaignId: number, status: CRMCampaignStatus): void {
        if (!this.initialized) return;
        try { this.run(`UPDATE crm_campaigns SET status=?, updated_at=? WHERE id=?`, [status, Date.now(), campaignId]); }
        catch (err: any) { Logger.error(`[DB] updateCRMCampaignStatus: ${err.message}`); }
    }

    public deleteCRMCampaign(campaignId: number, ownerZaloId: string): void {
        if (!this.initialized) return;
        try {
            this.runNoSave(`DELETE FROM crm_campaign_contacts WHERE campaign_id=?`, [campaignId]);
            this.runNoSave(`DELETE FROM crm_campaigns WHERE id=? AND owner_zalo_id=?`, [campaignId, ownerZaloId]);
            this.save();
        } catch (err: any) { Logger.error(`[DB] deleteCRMCampaign: ${err.message}`); }
    }

    public cloneCRMCampaign(campaignId: number, ownerZaloId: string, includeContacts: boolean, newName?: string): number {
        if (!this.initialized) return 0;
        try {
            const orig = this.getCRMCampaign(campaignId);
            if (!orig) { Logger.warn(`[DB] cloneCRMCampaign: campaign ${campaignId} not found`); return 0; }

            const newId = this.saveCRMCampaign({
                ...orig,
                id: 0,
                name: (newName?.trim()) || ((orig.name || '') + ' (bản sao)'),
                status: 'draft',
                owner_zalo_id: ownerZaloId,
            });
            if (!newId) { Logger.warn(`[DB] cloneCRMCampaign: saveCRMCampaign returned 0`); return 0; }

            if (includeContacts) {
                const contacts = this.getCampaignContacts(campaignId);
                if (contacts.length > 0) {
                    // Batch insert via a prepared statement to avoid per-row save() calls
                    const stmt = db!.prepare(
                        `INSERT OR IGNORE INTO crm_campaign_contacts
                         (campaign_id, owner_zalo_id, contact_id, display_name, avatar, status, sent_at, retry_count, error)
                         VALUES (?,?,?,?,?,?,?,?,?)`
                    );
                    for (const c of contacts) {
                        stmt.run(
                            newId,
                            ownerZaloId,
                            c.contact_id ?? '',
                            c.display_name ?? '',
                            c.avatar ?? '',
                            'pending',  // luôn reset về pending khi clone
                            0,          // sent_at
                            0,          // retry_count
                            '',         // error
                        );
                    }
                    Logger.log(`[DB] cloneCRMCampaign: copied ${contacts.length} contacts to campaign ${newId}`);
                }
            }

            return newId;
        } catch (err: any) { Logger.error(`[DB] cloneCRMCampaign: ${err.message}`); return 0; }
    }

    public addCampaignContacts(campaignId: number, ownerZaloId: string, contacts: Array<{ contactId: string; displayName?: string; avatar?: string; phone?: string }>): void {
        if (!this.initialized || !contacts.length) return;
        try {
            const stmt = db!.prepare(
                `INSERT OR IGNORE INTO crm_campaign_contacts (campaign_id, owner_zalo_id, contact_id, display_name, avatar, phone, status, sent_at, retry_count, error) VALUES (?,?,?,?,?,?,'pending',0,0,'')`
            );
            for (const c of contacts) {
                stmt.run(campaignId, ownerZaloId, c.contactId, c.displayName || '', c.avatar || '', c.phone || '');
            }
            this.save();
        } catch (err: any) { Logger.error(`[DB] addCampaignContacts: ${err.message}`); }
    }

    public getCampaignContacts(campaignId: number): CRMCampaignContact[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT * FROM crm_campaign_contacts WHERE campaign_id=? ORDER BY id`, [campaignId]);
        } catch (err: any) { Logger.error(`[DB] getCampaignContacts: ${err.message}`); return []; }
    }

    public deleteCampaignContacts(campaignId: number, contactIds: string[]): void {
        if (!this.initialized || !contactIds.length) return;
        try {
            const placeholders = contactIds.map(() => '?').join(',');
            this.run(`DELETE FROM crm_campaign_contacts WHERE campaign_id=? AND contact_id IN (${placeholders})`, [campaignId, ...contactIds]);
            this.save();
        } catch (err: any) { Logger.error(`[DB] deleteCampaignContacts: ${err.message}`); }
    }

    public deleteAllCampaignContacts(campaignId: number): void {
        if (!this.initialized) return;
        try {
            this.run(`DELETE FROM crm_campaign_contacts WHERE campaign_id=?`, [campaignId]);
            this.save();
        } catch (err: any) { Logger.error(`[DB] deleteAllCampaignContacts: ${err.message}`); }
    }

    public updateCampaignContactStatus(id: number, status: CRMContactStatus, error?: string): void {
        if (!this.initialized) return;
        try {
            const sentAt = status === 'sent' ? Date.now() : 0;
            const incRetry = status === 'failed' ? 1 : 0;
            this.run(
                `UPDATE crm_campaign_contacts SET status=?, sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END, error=?, retry_count=retry_count+? WHERE id=?`,
                [status, status, sentAt, error || '', incRetry, id]
            );
        } catch (err: any) { Logger.error(`[DB] updateCampaignContactStatus: ${err.message}`); }
    }

    /** Update contact_id and display_name after phone resolution at send time */
    public updateCampaignContactId(id: number, newContactId: string, displayName: string): void {
        if (!this.initialized) return;
        try {
            this.run(
                `UPDATE crm_campaign_contacts SET contact_id=?, display_name=? WHERE id=?`,
                [newContactId, displayName, id]
            );
        } catch (err: any) { Logger.error(`[DB] updateCampaignContactId: ${err.message}`); }
    }

    /** Lấy item tiếp theo cần gửi cho account này */
    public getNextPendingCampaignContact(ownerZaloId: string): CRMCampaignContact | null {
        if (!this.initialized) return null;
        try {
            const rows = this.query<any>(
                `SELECT cc.*, c.template_message, c.delay_seconds, c.delay_min_seconds, c.delay_max_seconds,
                    c.per_contact_delay_min_seconds, c.per_contact_delay_max_seconds,
                    c.campaign_type, c.friend_request_message, c.mixed_config,
                    COALESCE(cont.phone, fr.phone, '') as phone,
                    COALESCE(cont.contact_type, 'user') as contact_type
                 FROM crm_campaign_contacts cc
                 JOIN crm_campaigns c ON c.id=cc.campaign_id
                 LEFT JOIN contacts cont ON cont.owner_zalo_id=cc.owner_zalo_id AND cont.contact_id=cc.contact_id
                 LEFT JOIN friends fr ON fr.owner_zalo_id=cc.owner_zalo_id AND fr.user_id=cc.contact_id
                 WHERE cc.owner_zalo_id=? AND cc.status='pending' AND c.status='active' AND cc.retry_count < 3
                 ORDER BY cc.id LIMIT 1`,
                [ownerZaloId]
            );
            return rows[0] || null;
        } catch (err: any) { Logger.error(`[DB] getNextPendingCampaignContact: ${err.message}`); return null; }
    }

    /** Kiểm tra có campaign nào đang active không */
    public hasActiveCampaigns(ownerZaloId: string): boolean {
        if (!this.initialized) return false;
        try {
            const rows = this.query<any>(
                `SELECT 1 FROM crm_campaigns c
                 WHERE c.owner_zalo_id=? AND c.status='active'
                 AND EXISTS (SELECT 1 FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='pending')
                 LIMIT 1`,
                [ownerZaloId]
            );
            return rows.length > 0;
        } catch { return false; }
    }

    /** Lấy danh sách distinct owner_zalo_id có campaign đang active (dùng khi resume sau restart) */
    public getActiveCampaignOwners(): string[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT DISTINCT owner_zalo_id FROM crm_campaigns WHERE status='active'`, []
            ).map((r: any) => r.owner_zalo_id);
        } catch (err: any) { Logger.error(`[DB] getActiveCampaignOwners: ${err.message}`); return []; }
    }

    /** Đếm số liên hệ đã gửi trong ngày hôm nay cho 1 campaign (dùng cho daily limit check) */
    public getDailySentCountForCampaign(campaignId: number): number {
        if (!this.initialized) return 0;
        try {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const rows = this.query<any>(
                `SELECT COUNT(*) as cnt FROM crm_campaign_contacts WHERE campaign_id=? AND status='sent' AND sent_at >= ?`,
                [campaignId, todayStart.getTime()]
            );
            return rows[0]?.cnt ?? 0;
        } catch { return 0; }
    }

    /** Send Log */
    public saveSendLog(log: CRMSendLog): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT INTO crm_send_log (owner_zalo_id, channel, contact_id, display_name, phone, contact_type, campaign_id, message, sent_at, status, error, data_request, data_response, send_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [log.owner_zalo_id, log.channel || 'zalo', log.contact_id, log.display_name || '', this.normalizeVietnamPhone(log.phone || ''), log.contact_type || 'user', log.campaign_id || null, log.message, log.sent_at, log.status, log.error || '', log.data_request || '', log.data_response || '', log.send_type || '']
            );
        } catch (err: any) { Logger.error(`[DB] saveSendLog failed: ${err.message}`); }
    }

    public getSendLog(ownerZaloId: string, opts: { contactId?: string; campaignId?: number; limit?: number } = {}): CRMSendLog[] {
        if (!this.initialized) return [];
        try {
            let q = `SELECT * FROM crm_send_log WHERE owner_zalo_id=?`;
            const params: any[] = [ownerZaloId];
            if (opts.contactId) { q += ` AND contact_id=?`; params.push(opts.contactId); }
            if (opts.campaignId) { q += ` AND campaign_id=?`; params.push(opts.campaignId); }
            q += ` ORDER BY sent_at DESC LIMIT ?`;
            params.push(opts.limit || 100);
            return this.query<any>(q, params);
        } catch (err: any) { Logger.error(`[DB] getSendLog: ${err.message}`); return []; }
    }

    /** Top N campaigns with detailed stats including replied count */
    public getTopCampaignStats(ownerZaloId: string, limit = 10): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`
                SELECT
                    c.id, c.name, c.campaign_type, c.created_at, c.status,
                    COUNT(DISTINCT cc.id) as total_contacts,
                    COALESCE(SUM(CASE WHEN cc.status='sent' THEN 1 ELSE 0 END), 0) as sent_count,
                    COALESCE(SUM(CASE WHEN cc.status='failed' THEN 1 ELSE 0 END), 0) as failed_count,
                    COALESCE(SUM(CASE WHEN cc.status='pending' THEN 1 ELSE 0 END), 0) as pending_count,
                    COUNT(DISTINCT CASE
                        WHEN EXISTS(
                            SELECT 1 FROM messages m
                            WHERE m.owner_zalo_id = cc.owner_zalo_id
                              AND m.thread_id = cc.contact_id
                              AND m.is_sent = 0
                              AND m.timestamp > cc.sent_at
                              AND cc.status = 'sent'
                              AND cc.sent_at > 0
                        ) THEN cc.contact_id END
                    ) as replied_count
                FROM crm_campaigns c
                LEFT JOIN crm_campaign_contacts cc ON cc.campaign_id = c.id
                WHERE c.owner_zalo_id = ?
                GROUP BY c.id
                ORDER BY c.created_at DESC
                LIMIT ?
            `, [ownerZaloId, limit]);
        } catch (err: any) { Logger.error(`[DB] getTopCampaignStats: ${err.message}`); return []; }
    }

    /** CRM Contacts - aggregate friends + contacts, dedup */
    public getCRMContacts(ownerZaloId: string, opts: {
        search?: string; tagIds?: number[]; isFriendOnly?: boolean;
        contactType?: 'all' | 'friend' | 'group' | 'non_friend';
        contactTypes?: ('friend' | 'group' | 'non_friend')[];
        sortBy?: 'name' | 'last_message'; sortDir?: 'asc' | 'desc';
        limit?: number; offset?: number;
        /** Nhãn / Có SĐT / Có ghi chú / Giới tính / Sinh nhật — lọc trước khi cắt trang (shared/crm/crmContactFilters) */
        filters?: CRMContactFilters;
    } = {}): { contacts: any[]; total: number } {
        if (!this.initialized) return { contacts: [], total: 0 };
        try {
            const { search, isFriendOnly, contactType = 'all', contactTypes, sortBy = 'name', sortDir = 'asc', limit = 50, offset = 0, filters } = opts;

            let all: any[] = [];

            // Determine effective type filter
            // contactTypes (array) takes priority; fallback to legacy contactType
            const effectiveTypes: ('friend' | 'group' | 'non_friend')[] | null =
                (contactTypes && contactTypes.length > 0) ? contactTypes : null;
            const legacyType = isFriendOnly ? 'friend' : (contactType || 'all');

            if (!effectiveTypes && legacyType === 'group') {
                // Only group contacts (legacy fast path)
                all = this.query<any>(
                    `SELECT contact_id, COALESCE(alias,'') as alias, COALESCE(display_name,'') as display_name,
                        COALESCE(avatar_url,'') as avatar, '' as phone,
                        0 as is_friend, COALESCE(last_message_time,0) as last_message_time, 'group' as contact_type,
                        gender, birthday, COALESCE(info_refreshed_at,0) as info_refreshed_at
                     FROM contacts WHERE owner_zalo_id=? AND contact_type='group'
                     AND contact_id IS NOT NULL AND contact_id != ''`,
                    [ownerZaloId]
                );
            } else if (!effectiveTypes && legacyType === 'friend') {
                // Only friends (legacy fast path)
                all = this.query<any>(
                    `SELECT f.user_id as contact_id, COALESCE(c.alias,'') as alias,
                        COALESCE(c.display_name, f.display_name,'') as display_name,
                        COALESCE(c.avatar_url, f.avatar,'') as avatar,
                        COALESCE(c.phone, f.phone,'') as phone,
                        1 as is_friend,
                        COALESCE(c.last_message_time, 0) as last_message_time, 'user' as contact_type,
                        c.gender, c.birthday, COALESCE(c.info_refreshed_at,0) as info_refreshed_at
                     FROM friends f
                     LEFT JOIN contacts c ON c.owner_zalo_id=f.owner_zalo_id AND c.contact_id=f.user_id
                     WHERE f.owner_zalo_id=?`,
                    [ownerZaloId]
                );
            } else {
                // Build full list: friends + non-friend contacts (including groups)
                const friends = this.query<any>(
                    `SELECT f.user_id as contact_id, COALESCE(c.alias,'') as alias,
                        COALESCE(c.display_name, f.display_name,'') as display_name,
                        COALESCE(c.avatar_url, f.avatar,'') as avatar,
                        COALESCE(c.phone, f.phone,'') as phone,
                        1 as is_friend,
                        COALESCE(c.last_message_time, 0) as last_message_time, 'user' as contact_type,
                        c.gender, c.birthday, COALESCE(c.info_refreshed_at,0) as info_refreshed_at
                     FROM friends f
                     LEFT JOIN contacts c ON c.owner_zalo_id=f.owner_zalo_id AND c.contact_id=f.user_id
                     WHERE f.owner_zalo_id=?`,
                    [ownerZaloId]
                );
                const friendIds = new Set(friends.map((f: any) => f.contact_id));
                const otherContacts = this.query<any>(
                    `SELECT contact_id, COALESCE(alias,'') as alias, COALESCE(display_name,'') as display_name,
                        COALESCE(avatar_url,'') as avatar, COALESCE(phone,'') as phone,
                        is_friend, COALESCE(last_message_time,0) as last_message_time,
                        COALESCE(contact_type,'user') as contact_type,
                        gender, birthday, COALESCE(info_refreshed_at,0) as info_refreshed_at
                     FROM contacts WHERE owner_zalo_id=?
                     AND contact_id IS NOT NULL AND contact_id != ''`,
                    [ownerZaloId]
                ).filter((c: any) => !friendIds.has(c.contact_id));
                all = [...friends, ...otherContacts];

                // Apply multi-type filter when provided
                if (effectiveTypes && effectiveTypes.length < 3) {
                    all = all.filter((c: any) => {
                        const isFriendContact = c.is_friend === 1;
                        const isGroup = c.contact_type === 'group';
                        const isNonFriend = !isFriendContact && !isGroup;
                        return (
                            (effectiveTypes.includes('friend') && isFriendContact) ||
                            (effectiveTypes.includes('group') && isGroup) ||
                            (effectiveTypes.includes('non_friend') && isNonFriend)
                        );
                    });
                } else if (!effectiveTypes && legacyType === 'non_friend') {
                    // Legacy non_friend single type
                    all = all.filter((c: any) => c.is_friend !== 1 && c.contact_type !== 'group');
                }
            }

            // Apply search filter
            if (search?.trim()) {
                const q = search.toLowerCase();
                all = all.filter(c =>
                    (c.display_name || '').toLowerCase().includes(q) ||
                    (c.alias || '').toLowerCase().includes(q) ||
                    (c.phone || '').toLowerCase().includes(q) ||
                    c.contact_id.toLowerCase().includes(q)
                );
            }

            // Bộ lọc của trang Liên hệ — trên TOÀN BỘ danh sách (trước đây CRMPage chỉ lọc trang đang tải)
            let allNoteCounts: Map<string, number> | null = null;
            if (hasCRMContactFilters(filters)) {
                const localIds = (filters!.localLabelIds || []).map(Number).filter(Number.isFinite);
                const localByThread = new Map<string, Set<number>>();
                if (localIds.length > 0) {
                    this.query<any>(
                        `SELECT thread_id, label_id FROM local_label_threads WHERE owner_zalo_id=? AND label_id IN (${localIds.map(() => '?').join(',')})`,
                        [ownerZaloId, ...localIds]
                    ).forEach((r: any) => {
                        const key = String(r.thread_id);
                        if (!localByThread.has(key)) localByThread.set(key, new Set());
                        localByThread.get(key)!.add(Number(r.label_id));
                    });
                }
                if (filters!.hasNotes) allNoteCounts = this.getCRMNoteCounts(ownerZaloId);
                const matches = createCRMContactFilter(filters, {
                    localLabelsOf: (id) => localByThread.get(id),
                    noteCountOf: (id) => allNoteCounts?.get(id) ?? 0,
                });
                if (matches) all = all.filter(matches);
            }

            // Sort
            all.sort((a, b) => {
                let va: any, vb: any;
                if (sortBy === 'last_message') {
                    va = a.last_message_time; vb = b.last_message_time;
                } else {
                    va = (a.alias || a.display_name || '').toLowerCase();
                    vb = (b.alias || b.display_name || '').toLowerCase();
                }
                if (va < vb) return sortDir === 'asc' ? -1 : 1;
                if (va > vb) return sortDir === 'asc' ? 1 : -1;
                return 0;
            });

            const total = all.length;

            // Paginate + note counts
            const page = all.slice(offset, offset + limit);
            const noteCounts = allNoteCounts ?? this.getCRMNoteCounts(ownerZaloId, page.map((c: any) => String(c.contact_id)));

            const contacts = page.map((c: any) => ({
                ...c,
                note_count: noteCounts.get(String(c.contact_id)) || 0,
            }));

            return { contacts, total };
        } catch (err: any) { Logger.error(`[DB] getCRMContacts: ${err.message}`); return { contacts: [], total: 0 }; }
    }

    /**
     * Số ghi chú CRM theo liên hệ. Trang lớn (Xuất CSV lấy tới 100.000 dòng) đếm cả tài khoản bằng một GROUP BY —
     * danh sách `IN (?, …)` dài vượt giới hạn tham số của SQLite làm cả truy vấn lỗi (danh sách xuất ra rỗng).
     */
    private getCRMNoteCounts(ownerZaloId: string, contactIds?: string[]): Map<string, number> {
        const counts = new Map<string, number>();
        if (contactIds && contactIds.length === 0) return counts;
        const byIds = !!contactIds && contactIds.length <= 500;
        this.query<any>(
            byIds
                ? `SELECT contact_id, COUNT(*) as n FROM crm_notes WHERE owner_zalo_id=? AND contact_id IN (${contactIds!.map(() => '?').join(',')}) GROUP BY contact_id`
                : `SELECT contact_id, COUNT(*) as n FROM crm_notes WHERE owner_zalo_id=? GROUP BY contact_id`,
            byIds ? [ownerZaloId, ...contactIds!] : [ownerZaloId]
        ).forEach((r: any) => { counts.set(String(r.contact_id), Number(r.n) || 0); });
        return counts;
    }

    /** Activity stats for a given time window - used by CRM Dashboard */
    public getActivityStats(ownerZaloId: string, sinceTs: number, untilTs: number = Date.now()): {
        conversationCount: number; messageCount: number; sentCount: number; receivedCount: number;
    } {
        if (!this.initialized) return { conversationCount: 0, messageCount: 0, sentCount: 0, receivedCount: 0 };
        try {
            const row = this.queryOne<any>(
                `SELECT COUNT(DISTINCT thread_id) as conv_cnt,
                        COUNT(*) as msg_cnt,
                        COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END), 0) as sent_cnt
                 FROM messages
                 WHERE owner_zalo_id=? AND timestamp >= ? AND timestamp <= ?`,
                [ownerZaloId, sinceTs, untilTs]
            );
            const conversationCount = row?.conv_cnt || 0;
            const messageCount = row?.msg_cnt || 0;
            const sentCount = row?.sent_cnt || 0;
            return { conversationCount, messageCount, sentCount, receivedCount: messageCount - sentCount };
        } catch (err: any) {
            Logger.error(`[DB] getActivityStats: ${err.message}`);
            return { conversationCount: 0, messageCount: 0, sentCount: 0, receivedCount: 0 };
        }
    }

    /** Unfiltered aggregate stats - used by CRM Dashboard */
    public getContactStats(ownerZaloId: string): { total: number; friendCount: number; noteCount: number } {
        if (!this.initialized) return { total: 0, friendCount: 0, noteCount: 0 };
        try {
            const friendCount: number = this.query<any>(
                `SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id=?`,
                [ownerZaloId]
            )[0]?.cnt || 0;

            const nonFriendCount: number = this.query<any>(
                `SELECT COUNT(*) as cnt FROM contacts
                 WHERE owner_zalo_id=? AND contact_type != 'group'
                 AND contact_id IS NOT NULL AND contact_id != ''
                 AND contact_id NOT IN (SELECT user_id FROM friends WHERE owner_zalo_id=?)`,
                [ownerZaloId, ownerZaloId]
            )[0]?.cnt || 0;

            const noteCount: number = this.query<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_notes WHERE owner_zalo_id=?`,
                [ownerZaloId]
            )[0]?.cnt || 0;

            return { total: friendCount + nonFriendCount, friendCount, noteCount };
        } catch (err: any) {
            Logger.error(`[DB] getContactStats: ${err.message}`);
            return { total: 0, friendCount: 0, noteCount: 0 };
        }
    }

    // ─── Analytics / Reporting ────────────────────────────────────────────────

    /**
     * Per-account overview scoped to the date and conversation filters selected
     * in Reports. It must never silently count the whole message archive.
     */
    public getDashboardOverview(zaloId: string, sinceTs?: number, untilTs?: number, threadType?: number): {
        totalMessages: number; totalSent: number; totalReceived: number;
        totalContacts: number; totalFriends: number; totalGroups: number;
        todayMessages: number; todaySent: number; todayReceived: number;
        yesterdayMessages: number;
        activeCampaigns: number; totalCampaigns: number;
    } {
        const empty = { totalMessages: 0, totalSent: 0, totalReceived: 0, totalContacts: 0, totalFriends: 0, totalGroups: 0, todayMessages: 0, todaySent: 0, todayReceived: 0, yesterdayMessages: 0, activeCampaigns: 0, totalCampaigns: 0 };
        if (!this.initialized || !zaloId) return empty;
        try {
            // Today range
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
            const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
            const yesterdayStart = todayStart - 86400000;
            const yesterdayEnd = todayStart - 1;
            const rangeStart = Number.isFinite(sinceTs) ? Number(sinceTs) : todayStart;
            const rangeEnd = Number.isFinite(untilTs) ? Number(untilTs) : todayEnd;
            const threadFilter = threadType !== undefined && threadType !== -1 ? ' AND thread_type = ?' : '';
            const threadParams = threadFilter ? [threadType] : [];
            const periodRow = this.queryOne<any>(
                `SELECT COUNT(*) AS total,
                        COALESCE(SUM(CASE WHEN is_sent = 1 THEN 1 ELSE 0 END), 0) AS sent
                 FROM messages
                 WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}`,
                [zaloId, rangeStart, rangeEnd, ...threadParams],
            );
            const todayRow = this.queryOne<any>(
                `SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent FROM messages WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}`,
                [zaloId, todayStart, todayEnd, ...threadParams]
            );
            const yestRow = this.queryOne<any>(
                `SELECT COUNT(*) as total FROM messages WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}`,
                [zaloId, yesterdayStart, yesterdayEnd, ...threadParams]
            );
            const contactRow = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type != 'group'`,
                [zaloId]
            );
            const friendRow = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id = ?`,
                [zaloId]
            );
            const groupRow = this.queryOne<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type = 'group'`,
                [zaloId]
            );
            const campRow = this.queryOne<any>(
                `SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) as active FROM crm_campaigns WHERE owner_zalo_id = ?`,
                [zaloId]
            );

            return {
                totalMessages: periodRow?.total || 0,
                totalSent: periodRow?.sent || 0,
                totalReceived: (periodRow?.total || 0) - (periodRow?.sent || 0),
                totalContacts: contactRow?.cnt || 0,
                totalFriends: friendRow?.cnt || 0,
                totalGroups: groupRow?.cnt || 0,
                todayMessages: todayRow?.total || 0,
                todaySent: todayRow?.sent || 0,
                todayReceived: (todayRow?.total || 0) - (todayRow?.sent || 0),
                yesterdayMessages: yestRow?.total || 0,
                activeCampaigns: campRow?.active || 0,
                totalCampaigns: campRow?.total || 0,
            };
        } catch (err: any) {
            Logger.error(`[DB] getDashboardOverview: ${err.message}`);
            return empty;
        }
    }

    /**
     * Message volume timeline: messages per local clock hour ('hour') or local calendar day ('day').
     * Buckets follow the calendar whatever sinceTs is (see shared/analytics/localTimeBuckets): bucketing by
     * (timestamp - sinceTs) / 86400000 shifted every day by the time of day of sinceTs and left
     * the last bucket ("today") always empty.
     */
    public getMessageVolume(zaloId: string, sinceTs: number, untilTs: number, granularity: 'hour' | 'day', threadType?: number): Array<{
        bucket: string; sent: number; received: number; total: number;
    }> {
        if (!this.initialized || !zaloId) return [];
        try {
            const threadFilter = threadType !== undefined && threadType !== -1 ? ' AND thread_type = ?' : '';
            const threadParams = threadType !== undefined && threadType !== -1 ? [threadType] : [];
            const bucketExpr = granularity === 'hour' ? sqlLocalHour('timestamp') : sqlLocalDay('timestamp');
            const rows = this.query<any>(
                `SELECT ${bucketExpr} as bucket_key,
                    COUNT(*) as total,
                    COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent
                FROM messages
                WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}
                GROUP BY bucket_key`,
                [zaloId, sinceTs, untilTs, ...threadParams]
            );
            const rowMap = new Map(rows.map((r: any) => [r.bucket_key, r]));
            const buckets = granularity === 'hour' ? localHourBuckets(sinceTs, untilTs) : localDayBuckets(sinceTs, untilTs);
            return buckets.map(b => {
                const r = rowMap.get(b.key);
                const total = Number(r?.total || 0);
                const sent = Number(r?.sent || 0);
                return { bucket: b.label, sent, received: total - sent, total };
            });
        } catch (err: any) {
            Logger.error(`[DB] getMessageVolume: ${err.message}`);
            return [];
        }
    }

    /**
     * Response time analytics: measures how long it takes to reply to incoming messages.
     *
     * For each 1-to-1 thread, finds pairs of:
     *   - incoming message (is_sent=0) followed by outgoing reply (is_sent=1)
     * and calculates the time gap.
     *
     * Returns: avgSeconds, medianSeconds, minSeconds, maxSeconds,
     *          totalConversations (threads with at least 1 reply pair),
     *          totalReplies, distribution (bucketed histogram),
     *          byHour (avg response time by hour of day)
     *
     * Several accounts (Reports multi-select) are measured in one query, so the median / min / max
     * cover all their replies; a thread is keyed by (owner, thread) there — the same customer chatting
     * with two accounts stays two conversations. One account keeps the original single-owner SQL.
     */
    public getResponseTimeStats(zaloIds: string | string[], sinceTs: number, untilTs: number, threadType?: number): {
        avgSeconds: number;
        medianSeconds: number;
        minSeconds: number;
        maxSeconds: number;
        totalConversations: number;
        totalReplies: number;
        distribution: Array<{ bucket: string; count: number }>;
        byHour: Array<{ hour: number; avgSeconds: number; count: number }>;
    } {
        const empty = { avgSeconds: 0, medianSeconds: 0, minSeconds: 0, maxSeconds: 0, totalConversations: 0, totalReplies: 0, distribution: [], byHour: [] };
        const accountIds = analyticsAccountIds(zaloIds);
        if (!this.initialized || accountIds.length === 0) return empty;
        try {
            const ttFilter = threadType !== undefined && threadType !== -1 ? threadType : 0;
            const multi = accountIds.length > 1;
            const owner = multi ? 'owner_zalo_id, ' : '';
            const threadKey = multi ? 'owner_zalo_id || char(31) || thread_id' : 'thread_id';
            // Keep aggregation inside SQLite.  The former implementation copied
            // every message in the selected period into V8 and built large JS
            // arrays before returning a small summary.  At millions of messages
            // that can exhaust Electron's main-process heap.
            const repliesCte = `
                WITH ordered AS (
                    SELECT ${owner}thread_id, is_sent, timestamp, id,
                        COALESCE(SUM(CASE WHEN is_sent = 1 THEN 1 ELSE 0 END) OVER (
                            PARTITION BY ${owner}thread_id ORDER BY timestamp ASC, id ASC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                        ), 0) AS sent_before
                    FROM messages
                    WHERE ${sqlAccountFilter('owner_zalo_id', accountIds)} AND thread_type = ?
                      AND timestamp >= ? AND timestamp <= ?
                ), matched AS (
                    SELECT ${owner}thread_id, is_sent, timestamp AS reply_ts,
                        MAX(CASE WHEN is_sent = 0 THEN timestamp END) OVER (
                            PARTITION BY ${owner}thread_id, sent_before
                        ) AS incoming_ts
                    FROM ordered
                ), replies AS (
                    SELECT ${owner}thread_id, reply_ts, incoming_ts, reply_ts - incoming_ts AS gap_ms
                    FROM matched
                    WHERE is_sent = 1 AND incoming_ts IS NOT NULL
                      AND reply_ts >= incoming_ts
                      AND reply_ts - incoming_ts < 604800000
                )`;
            const queryParams = [...accountIds, ttFilter, sinceTs, untilTs];
            const stats = this.queryOne<any>(`${repliesCte}
                SELECT COUNT(*) AS total_replies,
                    COUNT(DISTINCT ${threadKey}) AS total_threads,
                    COALESCE(AVG(gap_ms), 0) AS avg_ms,
                    COALESCE(MIN(gap_ms), 0) AS min_ms,
                    COALESCE(MAX(gap_ms), 0) AS max_ms,
                    COALESCE(SUM(CASE WHEN gap_ms < 60000 THEN 1 ELSE 0 END), 0) AS b0,
                    COALESCE(SUM(CASE WHEN gap_ms >= 60000 AND gap_ms < 300000 THEN 1 ELSE 0 END), 0) AS b1,
                    COALESCE(SUM(CASE WHEN gap_ms >= 300000 AND gap_ms < 900000 THEN 1 ELSE 0 END), 0) AS b2,
                    COALESCE(SUM(CASE WHEN gap_ms >= 900000 AND gap_ms < 1800000 THEN 1 ELSE 0 END), 0) AS b3,
                    COALESCE(SUM(CASE WHEN gap_ms >= 1800000 AND gap_ms < 3600000 THEN 1 ELSE 0 END), 0) AS b4,
                    COALESCE(SUM(CASE WHEN gap_ms >= 3600000 AND gap_ms < 7200000 THEN 1 ELSE 0 END), 0) AS b5,
                    COALESCE(SUM(CASE WHEN gap_ms >= 7200000 AND gap_ms < 14400000 THEN 1 ELSE 0 END), 0) AS b6,
                    COALESCE(SUM(CASE WHEN gap_ms >= 14400000 AND gap_ms < 43200000 THEN 1 ELSE 0 END), 0) AS b7,
                    COALESCE(SUM(CASE WHEN gap_ms >= 43200000 AND gap_ms < 86400000 THEN 1 ELSE 0 END), 0) AS b8,
                    COALESCE(SUM(CASE WHEN gap_ms >= 86400000 THEN 1 ELSE 0 END), 0) AS b9
                FROM replies`, queryParams);
            const totalReplies = Number(stats?.total_replies || 0);
            if (!totalReplies) return empty;

            const median = this.queryOne<any>(`${repliesCte}
                SELECT gap_ms FROM replies ORDER BY gap_ms ASC LIMIT 1 OFFSET ?`, [...queryParams, Math.floor(totalReplies / 2)]);
            const hourRows = this.query<any>(`${repliesCte}
                SELECT CAST(strftime('%H', incoming_ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                    COUNT(*) AS count, AVG(gap_ms) AS avg_ms
                FROM replies GROUP BY hour`, queryParams);
            const hourMap = new Map(hourRows.map((row: any) => [Number(row.hour), row]));
            const byHour = Array.from({ length: 24 }, (_value, hour) => {
                const row = hourMap.get(hour);
                return { hour, avgSeconds: row ? Math.round(Number(row.avg_ms) / 1000) : 0, count: Number(row?.count || 0) };
            });
            const labels = ['< 1 phút', '1–5 phút', '5–15 phút', '15–30 phút', '30–60 phút', '1–2 giờ', '2–4 giờ', '4–12 giờ', '12–24 giờ', '> 24 giờ'];
            const distribution = labels.map((bucket, index) => ({ bucket, count: Number(stats?.[`b${index}`] || 0) }));

            return {
                avgSeconds: Math.round(Number(stats.avg_ms || 0) / 1000),
                medianSeconds: Math.round(Number(median?.gap_ms || 0) / 1000),
                minSeconds: Math.round(Number(stats.min_ms || 0) / 1000),
                maxSeconds: Math.round(Number(stats.max_ms || 0) / 1000),
                totalConversations: Number(stats.total_threads || 0),
                totalReplies,
                distribution,
                byHour,
            };
        } catch (err: any) {
            Logger.error(`[DB] getResponseTimeStats: ${err.message}`);
            return empty;
        }
    }

    /**
     * Label usage analytics: tracks how local labels are assigned to threads over time.
     *
     * Uses `local_label_threads.created_at` to build:
     *   - Total assignments in the period
     *   - Timeline (assignments per day)
     *   - Breakdown per label (name, emoji, color, count)
     *   - Recent assignments with timestamp details
     */
    public getLabelUsageAnalytics(zaloId: string, sinceTs: number, untilTs: number): {
        totalAssignments: number;
        totalLabelsUsed: number;
        avgPerDay: number;
        timeline: Array<{ bucket: string; count: number }>;
        byLabel: Array<{ labelId: number; name: string; emoji: string; color: string; count: number }>;
        recentAssignments: Array<{ labelName: string; emoji: string; color: string; threadId: string; createdAt: number }>;
    } {
        const empty = { totalAssignments: 0, totalLabelsUsed: 0, avgPerDay: 0, timeline: [], byLabel: [], recentAssignments: [] };
        if (!this.initialized || !zaloId) return empty;
        try {
            // Total assignments in period
            const totalRow = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM local_label_threads WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?`,
                [zaloId, sinceTs, untilTs]
            );
            const totalAssignments = totalRow?.cnt || 0;
            if (totalAssignments === 0) return empty;

            // Distinct labels used
            const labelsUsedRow = this.queryOne<any>(
                `SELECT COUNT(DISTINCT label_id) as cnt FROM local_label_threads WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?`,
                [zaloId, sinceTs, untilTs]
            );
            const totalLabelsUsed = labelsUsedRow?.cnt || 0;

            // Timeline: assignments per local calendar day; avg over the calendar days of the range
            const dayBuckets = localDayBuckets(sinceTs, untilTs);
            const days = Math.max(1, dayBuckets.length);
            const avgPerDay = Math.round((totalAssignments / days) * 10) / 10;
            const timelineRows = this.query<any>(
                `SELECT ${sqlLocalDay('created_at')} as day_key, COUNT(*) as cnt
                 FROM local_label_threads
                 WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?
                 GROUP BY day_key`,
                [zaloId, sinceTs, untilTs]
            );
            const timelineMap = new Map<string, number>(timelineRows.map((r: any) => [r.day_key, Number(r.cnt) || 0]));
            const timeline: Array<{ bucket: string; count: number }> = dayBuckets.map(b => ({ bucket: b.label, count: timelineMap.get(b.key) || 0 }));

            // By label breakdown
            const byLabel = this.query<any>(
                `SELECT llt.label_id, ll.name, ll.emoji, ll.color, COUNT(*) as cnt
                 FROM local_label_threads llt
                 INNER JOIN local_labels ll ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id = ? AND llt.created_at >= ? AND llt.created_at <= ?
                 GROUP BY llt.label_id
                 ORDER BY cnt DESC`,
                [zaloId, sinceTs, untilTs]
            ).map((r: any) => ({
                labelId: r.label_id,
                name: r.name || 'Không tên',
                emoji: r.emoji || '🏷️',
                color: r.color || '#3B82F6',
                count: r.cnt,
            }));

            // Recent assignments (last 50)
            const recentAssignments = this.query<any>(
                `SELECT ll.name as label_name, ll.emoji, ll.color, llt.thread_id, llt.created_at
                 FROM local_label_threads llt
                 INNER JOIN local_labels ll ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id = ? AND llt.created_at >= ? AND llt.created_at <= ?
                 ORDER BY llt.created_at DESC
                 LIMIT 50`,
                [zaloId, sinceTs, untilTs]
            ).map((r: any) => ({
                labelName: r.label_name || 'Không tên',
                emoji: r.emoji || '🏷️',
                color: r.color || '#3B82F6',
                threadId: r.thread_id,
                createdAt: r.created_at,
            }));

            return { totalAssignments, totalLabelsUsed, avgPerDay, timeline, byLabel, recentAssignments };
        } catch (err: any) {
            Logger.error(`[DB] getLabelUsageAnalytics: ${err.message}`);
            return empty;
        }
    }

    /**
     * Peak Hours Heatmap: 7 days × 24 hours grid of message counts
     * Returns array of { dayOfWeek: 0-6 (Mon-Sun), hour: 0-23, count: number }
     */
    public getPeakHoursHeatmap(zaloId: string, sinceTs: number, untilTs: number, threadType?: number): Array<{
        dayOfWeek: number; hour: number; count: number;
    }> {
        if (!this.initialized || !zaloId) return [];
        try {
            const threadFilter = threadType !== undefined && threadType !== -1 ? ' AND thread_type = ?' : '';
            const threadParams = threadType !== undefined && threadType !== -1 ? [threadType] : [];
            // Return the fixed 7×24 aggregate, never one IPC object per message.
            const rows = this.query<any>(
                `SELECT
                    (CAST(strftime('%w', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) + 6) % 7 AS day_of_week,
                    CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                    COUNT(*) AS count
                 FROM messages
                 WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}
                 GROUP BY day_of_week, hour`,
                [zaloId, sinceTs, untilTs, ...threadParams]
            );
            const grid = new Map(rows.map((row: any) => [`${row.day_of_week}_${row.hour}`, Number(row.count)]));
            const result: Array<{ dayOfWeek: number; hour: number; count: number }> = [];
            for (let d = 0; d < 7; d++) {
                for (let h = 0; h < 24; h++) {
                    result.push({ dayOfWeek: d, hour: h, count: grid.get(`${d}_${h}`) || 0 });
                }
            }
            return result;
        } catch (err: any) {
            Logger.error(`[DB] getPeakHoursHeatmap: ${err.message}`);
            return [];
        }
    }

    /**
     * Contact growth: new contacts appearing over time (by first message date)
     * Returns array of { bucket: 'dd/MM', newContacts: number, newFriends: number }
     */
    public getContactGrowth(zaloId: string, sinceTs: number, untilTs: number): Array<{
        bucket: string; newContacts: number; newFriends: number;
    }> {
        if (!this.initialized || !zaloId) return [];
        try {
            const rows = this.query<any>(
                `SELECT thread_id, owner_zalo_id, MIN(timestamp) as first_ts
                 FROM messages
                 WHERE owner_zalo_id = ? AND thread_type = 0 AND timestamp >= ? AND timestamp <= ?
                 GROUP BY owner_zalo_id, thread_id
                 HAVING first_ts >= ? AND first_ts <= ?`,
                [zaloId, sinceTs, untilTs, sinceTs, untilTs]
            );
            const friendSet = new Set<string>();
            const friendRows = this.query<any>(
                `SELECT owner_zalo_id, user_id FROM friends WHERE owner_zalo_id = ?`,
                [zaloId]
            );
            for (const f of friendRows) friendSet.add(`${f.owner_zalo_id}_${f.user_id}`);

            // Bucket by the local calendar day of the first message.
            const dayMap = new Map<string, { contacts: number; friends: number }>();
            for (const r of rows) {
                const dayKey = localDayKey(Number(r.first_ts));
                const entry = dayMap.get(dayKey) || { contacts: 0, friends: 0 };
                entry.contacts++;
                if (friendSet.has(`${r.owner_zalo_id}_${r.thread_id}`)) entry.friends++;
                dayMap.set(dayKey, entry);
            }
            return localDayBuckets(sinceTs, untilTs).map(b => {
                const entry = dayMap.get(b.key);
                return { bucket: b.label, newContacts: entry?.contacts || 0, newFriends: entry?.friends || 0 };
            });
        } catch (err: any) {
            Logger.error(`[DB] getContactGrowth: ${err.message}`);
            return [];
        }
    }

    /**
     * Contact segmentation: phân bổ contacts theo type, friend status, tag, note
     */
    public getContactSegmentation(zaloId: string): {
        byType: Array<{ type: string; count: number }>;
        tagged: number; untagged: number;
        withNotes: number; withoutNotes: number;
    } {
        const empty = { byType: [], tagged: 0, untagged: 0, withNotes: 0, withoutNotes: 0 };
        if (!this.initialized || !zaloId) return empty;
        try {
            const friendCount = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id = ?`,
                [zaloId]
            )?.cnt || 0;
            const nonFriendCount = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM contacts
                 WHERE owner_zalo_id = ? AND contact_type != 'group'
                 AND contact_id NOT IN (SELECT user_id FROM friends WHERE owner_zalo_id = ?)`,
                [zaloId, zaloId]
            )?.cnt || 0;
            const groupCount = this.queryOne<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type = 'group'`,
                [zaloId]
            )?.cnt || 0;

            const byType = [
                { type: 'Bạn bè', count: friendCount },
                { type: 'Người lạ', count: nonFriendCount },
                { type: 'Nhóm', count: groupCount },
            ];

            // Tagged vs untagged (CRM tags + local labels)
            const taggedContacts = this.queryOne<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_contact_tags WHERE owner_zalo_id = ?`,
                [zaloId]
            )?.cnt || 0;
            const labeledThreads = this.queryOne<any>(
                `SELECT COUNT(DISTINCT thread_id) as cnt FROM local_label_threads WHERE owner_zalo_id = ?`,
                [zaloId]
            )?.cnt || 0;
            const tagged = taggedContacts + labeledThreads;
            const totalContacts = friendCount + nonFriendCount;
            const untagged = Math.max(0, totalContacts - tagged);

            // With notes vs without
            const withNotes = this.queryOne<any>(
                `SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_notes WHERE owner_zalo_id = ?`,
                [zaloId]
            )?.cnt || 0;
            const withoutNotes = Math.max(0, totalContacts - withNotes);

            return { byType, tagged, untagged, withNotes, withoutNotes };
        } catch (err: any) {
            Logger.error(`[DB] getContactSegmentation: ${err.message}`);
            return empty;
        }
    }

    /**
     * Campaign comparison: all campaigns with detailed metrics
     */
    public getCampaignComparison(zaloId: string): Array<{
        id: number; name: string; type: string; status: string; created_at: number;
        total: number; sent: number; failed: number; pending: number; replied: number;
        deliveryRate: number; replyRate: number;
    }> {
        if (!this.initialized || !zaloId) return [];
        try {
            const rows = this.query<any>(`
                SELECT
                    c.id, c.name, c.campaign_type, c.status, c.created_at,
                    COUNT(DISTINCT cc.id) as total_contacts,
                    COALESCE(SUM(CASE WHEN cc.status='sent' THEN 1 ELSE 0 END), 0) as sent_count,
                    COALESCE(SUM(CASE WHEN cc.status='failed' THEN 1 ELSE 0 END), 0) as failed_count,
                    COALESCE(SUM(CASE WHEN cc.status='pending' THEN 1 ELSE 0 END), 0) as pending_count,
                    COUNT(DISTINCT CASE
                        WHEN EXISTS(
                            SELECT 1 FROM messages m
                            WHERE m.owner_zalo_id = cc.owner_zalo_id
                              AND m.thread_id = cc.contact_id
                              AND m.is_sent = 0
                              AND m.timestamp > cc.sent_at
                              AND cc.status = 'sent'
                              AND cc.sent_at > 0
                        ) THEN cc.contact_id END
                    ) as replied_count
                FROM crm_campaigns c
                LEFT JOIN crm_campaign_contacts cc ON cc.campaign_id = c.id
                WHERE c.owner_zalo_id = ?
                GROUP BY c.id
                ORDER BY c.created_at DESC
            `, [zaloId]);

            return rows.map((r: any) => {
                const total = r.total_contacts || 0;
                const sent = r.sent_count || 0;
                const replied = r.replied_count || 0;
                return {
                    id: r.id,
                    name: r.name,
                    type: r.campaign_type,
                    status: r.status,
                    created_at: r.created_at,
                    total,
                    sent,
                    failed: r.failed_count || 0,
                    pending: r.pending_count || 0,
                    replied,
                    deliveryRate: total > 0 ? Math.round(sent / total * 100) : 0,
                    replyRate: sent > 0 ? Math.round(replied / sent * 100) : 0,
                };
            });
        } catch (err: any) {
            Logger.error(`[DB] getCampaignComparison: ${err.message}`);
            return [];
        }
    }

    /**
     * Friend request analytics: sent/received/accepted over time
     */
    public getFriendRequestAnalytics(zaloId: string, sinceTs: number, untilTs: number): {
        totalSent: number; totalReceived: number;
        timeline: Array<{ bucket: string; sent: number; received: number }>;
    } {
        const empty = { totalSent: 0, totalReceived: 0, timeline: [] };
        if (!this.initialized || !zaloId) return empty;
        try {
            const sentCount = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM friend_requests WHERE owner_zalo_id = ? AND direction='sent' AND created_at >= ? AND created_at <= ?`,
                [zaloId, sinceTs, untilTs]
            )?.cnt || 0;
            const receivedCount = this.queryOne<any>(
                `SELECT COUNT(*) as cnt FROM friend_requests WHERE owner_zalo_id = ? AND direction='received' AND created_at >= ? AND created_at <= ?`,
                [zaloId, sinceTs, untilTs]
            )?.cnt || 0;

            const sentRows = this.query<any>(
                `SELECT ${sqlLocalDay('created_at')} as day_key, COUNT(*) as cnt
                 FROM friend_requests WHERE owner_zalo_id = ? AND direction='sent' AND created_at >= ? AND created_at <= ?
                 GROUP BY day_key`,
                [zaloId, sinceTs, untilTs]
            );
            const recvRows = this.query<any>(
                `SELECT ${sqlLocalDay('created_at')} as day_key, COUNT(*) as cnt
                 FROM friend_requests WHERE owner_zalo_id = ? AND direction='received' AND created_at >= ? AND created_at <= ?
                 GROUP BY day_key`,
                [zaloId, sinceTs, untilTs]
            );
            const sentMap = new Map<string, number>(sentRows.map((r: any) => [r.day_key, Number(r.cnt) || 0]));
            const recvMap = new Map<string, number>(recvRows.map((r: any) => [r.day_key, Number(r.cnt) || 0]));

            const timeline: Array<{ bucket: string; sent: number; received: number }> = localDayBuckets(sinceTs, untilTs)
                .map(b => ({ bucket: b.label, sent: sentMap.get(b.key) || 0, received: recvMap.get(b.key) || 0 }));

            return { totalSent: sentCount, totalReceived: receivedCount, timeline };
        } catch (err: any) {
            Logger.error(`[DB] getFriendRequestAnalytics: ${err.message}`);
            return empty;
        }
    }

    // ─── Workflow Analytics ─────────────────────────────────────────────────

    /**
     * Workflow analytics for an account: run counts, success/error rate, top workflows.
     * Several accounts (Reports multi-select): workflows attached to ANY of them, each run counted
     * once — runs carry no account, so summing per-account reports would count a workflow shared by
     * two selected accounts (page_ids) twice.
     */
    public getWorkflowAnalytics(zaloIds: string | string[], sinceTs: number, untilTs: number): {
        totalRuns: number; successRuns: number; errorRuns: number; successRate: number;
        avgDuration: number;
        topWorkflows: Array<{ workflowName: string; runs: number; successRate: number }>;
        timeline: Array<{ bucket: string; success: number; error: number }>;
    } {
        const empty = { totalRuns: 0, successRuns: 0, errorRuns: 0, successRate: 0, avgDuration: 0, topWorkflows: [], timeline: [] };
        const accountIds = analyticsAccountIds(zaloIds);
        if (!this.initialized || accountIds.length === 0) return empty;
        try {
            // Get workflows that belong to these accounts
            const wanted = new Set(accountIds);
            const allWfs = this.query<any>(`SELECT id, name, page_ids FROM workflows`);
            const accountWfIds = allWfs
                .filter((w: any) => (w.page_ids || '').split(',').filter(Boolean).some((id: string) => wanted.has(id)))
                .map((w: any) => w.id);
            if (accountWfIds.length === 0) return empty;

            const ph = accountWfIds.map(() => '?').join(',');

            // Overall stats
            const statsRow = this.queryOne<any>(
                `SELECT COUNT(*) as total,
                    COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) as success_cnt,
                    COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) as error_cnt,
                    COALESCE(AVG(CASE WHEN finished_at > 0 AND started_at > 0 THEN finished_at - started_at END),0) as avg_dur
                 FROM workflow_run_logs
                 WHERE workflow_id IN (${ph}) AND started_at >= ? AND started_at <= ?`,
                [...accountWfIds, sinceTs, untilTs]
            );

            const totalRuns = statsRow?.total || 0;
            const successRuns = statsRow?.success_cnt || 0;
            const errorRuns = statsRow?.error_cnt || 0;

            // Top workflows
            const topRows = this.query<any>(
                `SELECT workflow_name, COUNT(*) as runs,
                    COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) as success_cnt
                 FROM workflow_run_logs
                 WHERE workflow_id IN (${ph}) AND started_at >= ? AND started_at <= ?
                 GROUP BY workflow_id
                 ORDER BY runs DESC LIMIT 10`,
                [...accountWfIds, sinceTs, untilTs]
            );
            const topWorkflows = topRows.map((r: any) => ({
                workflowName: r.workflow_name,
                runs: r.runs,
                successRate: r.runs > 0 ? Math.round(r.success_cnt / r.runs * 100) : 0,
            }));

            // Timeline by local calendar day
            const tlRows = this.query<any>(
                `SELECT ${sqlLocalDay('started_at')} as day_key,
                    COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) as s,
                    COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) as e
                 FROM workflow_run_logs
                 WHERE workflow_id IN (${ph}) AND started_at >= ? AND started_at <= ?
                 GROUP BY day_key`,
                [...accountWfIds, sinceTs, untilTs]
            );
            const tlMap = new Map(tlRows.map((r: any) => [r.day_key, r]));
            const timeline: Array<{ bucket: string; success: number; error: number }> = localDayBuckets(sinceTs, untilTs).map(b => {
                const r = tlMap.get(b.key);
                return { bucket: b.label, success: Number(r?.s || 0), error: Number(r?.e || 0) };
            });

            return {
                totalRuns, successRuns, errorRuns,
                successRate: totalRuns > 0 ? Math.round(successRuns / totalRuns * 100) : 0,
                avgDuration: Math.round(statsRow?.avg_dur || 0),
                topWorkflows,
                timeline,
            };
        } catch (err: any) {
            Logger.error(`[DB] getWorkflowAnalytics: ${err.message}`);
            return empty;
        }
    }

    // ─── AI Analytics ─────────────────────────────────────────────────────

    /**
     * AI usage analytics: tokens consumed, request counts, model breakdown
     */
    public getAIAnalytics(sinceTs: number, untilTs: number): {
        totalRequests: number; totalTokens: number; totalPromptTokens: number; totalCompletionTokens: number;
        byModel: Array<{ model: string; requests: number; tokens: number }>;
        byAssistant: Array<{ assistantName: string; requests: number; tokens: number }>;
        timeline: Array<{ bucket: string; requests: number; tokens: number }>;
    } {
        const empty = { totalRequests: 0, totalTokens: 0, totalPromptTokens: 0, totalCompletionTokens: 0, byModel: [], byAssistant: [], timeline: [] };
        if (!this.initialized) return empty;
        try {
            // Overall stats
            const statsRow = this.queryOne<any>(
                `SELECT COUNT(*) as total,
                    COALESCE(SUM(total_tokens),0) as tokens,
                    COALESCE(SUM(prompt_tokens),0) as prompt_tokens,
                    COALESCE(SUM(completion_tokens),0) as completion_tokens
                 FROM ai_usage_logs WHERE created_at >= ? AND created_at <= ?`,
                [sinceTs, untilTs]
            );

            // By model
            const modelRows = this.query<any>(
                `SELECT model, COUNT(*) as requests, COALESCE(SUM(total_tokens),0) as tokens
                 FROM ai_usage_logs WHERE created_at >= ? AND created_at <= ?
                 GROUP BY model ORDER BY tokens DESC`,
                [sinceTs, untilTs]
            );

            // By assistant
            const assistantRows = this.query<any>(
                `SELECT assistant_name, COUNT(*) as requests, COALESCE(SUM(total_tokens),0) as tokens
                 FROM ai_usage_logs WHERE created_at >= ? AND created_at <= ?
                 GROUP BY assistant_id ORDER BY tokens DESC`,
                [sinceTs, untilTs]
            );

            // Timeline by local calendar day
            const tlRows = this.query<any>(
                `SELECT ${sqlLocalDay('created_at')} as day_key,
                    COUNT(*) as requests, COALESCE(SUM(total_tokens),0) as tokens
                 FROM ai_usage_logs WHERE created_at >= ? AND created_at <= ?
                 GROUP BY day_key`,
                [sinceTs, untilTs]
            );
            const tlMap = new Map(tlRows.map((r: any) => [r.day_key, r]));
            const timeline: Array<{ bucket: string; requests: number; tokens: number }> = localDayBuckets(sinceTs, untilTs).map(b => {
                const r = tlMap.get(b.key);
                return { bucket: b.label, requests: Number(r?.requests || 0), tokens: Number(r?.tokens || 0) };
            });

            return {
                totalRequests: statsRow?.total || 0,
                totalTokens: statsRow?.tokens || 0,
                totalPromptTokens: statsRow?.prompt_tokens || 0,
                totalCompletionTokens: statsRow?.completion_tokens || 0,
                byModel: modelRows.map((r: any) => ({ model: r.model || 'unknown', requests: r.requests, tokens: r.tokens })),
                byAssistant: assistantRows.map((r: any) => ({ assistantName: r.assistant_name || 'unknown', requests: r.requests, tokens: r.tokens })),
                timeline,
            };
        } catch (err: any) {
            Logger.error(`[DB] getAIAnalytics: ${err.message}`);
            return empty;
        }
    }

    // ─── Workflow Engine ──────────────────────────────────────────────────────

    public getWorkflows(): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT * FROM workflows ORDER BY updated_at DESC`).map(r => ({
                ...r,
                channel: this.normalizeWorkflowChannel(r.channel),
                // Normalise: prefer page_ids, fall back to page_id for old rows
                page_ids: r.page_ids && r.page_ids.trim()
                    ? r.page_ids
                    : (r.page_id && r.page_id.trim() ? r.page_id : ''),
            }));
        } catch (err: any) {
            Logger.error(`[DB] getWorkflows: ${err.message}`);
            return [];
        }
    }

    public getWorkflowById(id: string): any | null {
        if (!this.initialized) return null;
        try {
            const r = this.queryOne<any>(`SELECT * FROM workflows WHERE id=?`, [id]);
            if (!r) return null;
            return {
                ...r,
                channel: this.normalizeWorkflowChannel(r.channel),
                page_ids: r.page_ids && r.page_ids.trim()
                    ? r.page_ids
                    : (r.page_id && r.page_id.trim() ? r.page_id : ''),
            };
        } catch (err: any) {
            Logger.error(`[DB] getWorkflowById: ${err.message}`);
            return null;
        }
    }

    public saveWorkflow(wf: any): void {
        if (!this.initialized) throw new Error('DatabaseService not initialized');
        // pageIds: array → comma-separated string
        const pageIds = Array.isArray(wf.pageIds)
            ? wf.pageIds.filter(Boolean).join(',')
            : (wf.pageId || '');
        const channel = this.normalizeWorkflowChannel(wf.channel);
        this.run(
            `INSERT OR REPLACE INTO workflows
             (id, name, description, enabled, channel, page_id, page_ids, nodes_json, edges_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                wf.id, wf.name, wf.description || '', wf.enabled ? 1 : 0,
                channel,
                pageIds,   // keep page_id in sync with first page for legacy compat
                pageIds,
                JSON.stringify(wf.nodes || []), JSON.stringify(wf.edges || []),
                wf.createdAt || Date.now(), wf.updatedAt || Date.now(),
            ]
        );
    }

    public deleteWorkflow(id: string): void {
        if (!this.initialized) return;
        try {
            this.runNoSave(`DELETE FROM workflows WHERE id=?`, [id]);
            this.runNoSave(`DELETE FROM workflow_run_logs WHERE workflow_id=?`, [id]);
            this.save();
        } catch (err: any) {
            Logger.error(`[DB] deleteWorkflow: ${err.message}`);
        }
    }

    public toggleWorkflow(id: string, enabled: boolean): void {
        if (!this.initialized) return;
        try {
            this.run(`UPDATE workflows SET enabled=?, updated_at=? WHERE id=?`, [enabled ? 1 : 0, Date.now(), id]);
        } catch (err: any) {
            Logger.error(`[DB] toggleWorkflow: ${err.message}`);
        }
    }

    /**
     * Clone một workflow sang page đích.
     * Tạo bản sao mới (uuid mới) với pageIds = [targetZaloId], enabled = false.
     */
    public cloneWorkflow(sourceId: string, targetZaloId: string): string | null {
        if (!this.initialized) return null;
        try {
            const source = this.getWorkflowById(sourceId);
            if (!source) return null;
            const { v4: uuidv4 } = require('uuid');
            const newId = uuidv4();
            const now = Date.now();
            const channel = this.normalizeWorkflowChannel(source.channel);
            this.run(
                `INSERT INTO workflows
                 (id, name, description, enabled, channel, page_id, page_ids, nodes_json, edges_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    newId,
                    `${source.name} (copy)`,
                    source.description || '',
                    0,                // disabled by default
                    channel,
                    targetZaloId,
                    targetZaloId,
                    source.nodes_json,
                    source.edges_json,
                    now, now,
                ]
            );
            return newId;
        } catch (err: any) {
            Logger.error(`[DB] cloneWorkflow: ${err.message}`);
            return null;
        }
    }

    /**
     * Clone toàn bộ workflows thuộc sourceZaloId sang targetZaloId.
     * Trả về số lượng workflows đã clone.
     */
    public cloneAllWorkflows(sourceZaloId: string, targetZaloId: string): number {
        if (!this.initialized) return 0;
        try {
            const all = this.getWorkflows();
            // Lấy workflows có sourceZaloId trong page_ids
            const matching = all.filter(r => {
                const ids = (r.page_ids || '').split(',').filter(Boolean);
                return ids.includes(sourceZaloId);
            });
            let count = 0;
            for (const wf of matching) {
                const cloned = this.cloneWorkflow(wf.id, targetZaloId);
                if (cloned) count++;
            }
            return count;
        } catch (err: any) {
            Logger.error(`[DB] cloneAllWorkflows: ${err.message}`);
            return 0;
        }
    }

    public saveWorkflowRunLog(log: any): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT OR REPLACE INTO workflow_run_logs (id, workflow_id, workflow_name, triggered_by, started_at, finished_at, status, error_message, node_results)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    log.id, log.workflowId, log.workflowName, log.triggeredBy,
                    log.startedAt, log.finishedAt, log.status, log.errorMessage || null,
                    JSON.stringify(log.nodeResults || []),
                ]
            );
        } catch (err: any) {
            Logger.error(`[DB] saveWorkflowRunLog: ${err.message}`);
        }
    }

    public getWorkflowRunLogs(workflowId: string, limit: number = 50): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT * FROM workflow_run_logs WHERE workflow_id=? ORDER BY started_at DESC LIMIT ?`,
                [workflowId, limit]
            ).map((r: any) => ({ ...r, nodeResults: JSON.parse(r.node_results || '[]') }));
        } catch (err: any) {
            Logger.error(`[DB] getWorkflowRunLogs: ${err.message}`);
            return [];
        }
    }

    public getRecentRunLogs(limit: number = 100): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT * FROM workflow_run_logs ORDER BY started_at DESC LIMIT ?`,
                [limit]
            ).map((r: any) => ({ ...r, nodeResults: JSON.parse(r.node_results || '[]') }));
        } catch (err: any) {
            Logger.error(`[DB] getRecentRunLogs: ${err.message}`);
            return [];
        }
    }

    public deleteOldRunLogs(olderThanDays: number = 30): void {
        if (!this.initialized) return;
        try {
            const cutoff = Date.now() - olderThanDays * 86400_000;
            this.run(`DELETE FROM workflow_run_logs WHERE started_at < ?`, [cutoff]);
        } catch (err: any) {
            Logger.error(`[DB] deleteOldRunLogs: ${err.message}`);
        }
    }

    // ─── Integration Hub Operations ───────────────────────────────────────────

    public getIntegrations(): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT * FROM integrations ORDER BY created_at ASC`);
        } catch (err: any) {
            Logger.error(`[DB] getIntegrations: ${err.message}`);
            return [];
        }
    }

    public upsertIntegration(row: {
        id: string; type: string; name: string; enabled: number;
        credentials_encrypted: string; settings: string;
        connected_at: number | null; created_at: number; updated_at: number;
    }): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT INTO integrations (id, type, name, enabled, credentials_encrypted, settings, connected_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   type=excluded.type, name=excluded.name, enabled=excluded.enabled,
                   credentials_encrypted=excluded.credentials_encrypted,
                   settings=excluded.settings, connected_at=excluded.connected_at,
                   updated_at=excluded.updated_at`,
                [row.id, row.type, row.name, row.enabled, row.credentials_encrypted,
                 row.settings, row.connected_at, row.created_at, row.updated_at]
            );
        } catch (err: any) {
            Logger.error(`[DB] upsertIntegration: ${err.message}`);
        }
    }

    public deleteIntegration(id: string): void {
        if (!this.initialized) return;
        try {
            this.run(`DELETE FROM integrations WHERE id = ?`, [id]);
        } catch (err: any) {
            Logger.error(`[DB] deleteIntegration: ${err.message}`);
        }
    }

    public toggleIntegration(id: string, enabled: boolean): void {
        if (!this.initialized) return;
        try {
            this.run(`UPDATE integrations SET enabled = ?, updated_at = ? WHERE id = ?`,
                [enabled ? 1 : 0, Date.now(), id]);
        } catch (err: any) {
            Logger.error(`[DB] toggleIntegration: ${err.message}`);
        }
    }

    public markIntegrationConnected(id: string, connectedAt: number): void {
        if (!this.initialized) return;
        try {
            this.run(`UPDATE integrations SET connected_at = ?, updated_at = ? WHERE id = ?`,
                [connectedAt, Date.now(), id]);
        } catch (err: any) {
            Logger.error(`[DB] markIntegrationConnected: ${err.message}`);
        }
    }

    // ─── Message Draft Operations ─────────────────────────────────────────

    /** Upsert draft: lưu hoặc cập nhật nội dung draft cho 1 thread */
    public upsertDraft(ownerZaloId: string, threadId: string, content: string): void {
        if (!this.initialized || !threadId) return;
        try {
            this.run(
                `INSERT INTO message_drafts (owner_zalo_id, thread_id, content, updated_at)
                 VALUES (?,?,?,?)
                 ON CONFLICT(owner_zalo_id, thread_id) DO UPDATE SET
                   content=excluded.content,
                   updated_at=excluded.updated_at`,
                [ownerZaloId, threadId, content, Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DB] upsertDraft error: ${err.message}`);
        }
    }

    /** Xoá draft cho 1 thread (khi gửi tin nhắn hoặc xoá hết text) */
    public deleteDraft(ownerZaloId: string, threadId: string): void {
        if (!this.initialized || !threadId) return;
        try {
            this.run(
                `DELETE FROM message_drafts WHERE owner_zalo_id = ? AND thread_id = ?`,
                [ownerZaloId, threadId]
            );
        } catch (err: any) {
            Logger.error(`[DB] deleteDraft error: ${err.message}`);
        }
    }

    /** Lấy draft cho 1 thread */
    public getDraft(ownerZaloId: string, threadId: string): { content: string; updatedAt: number } | null {
        if (!this.initialized) return null;
        try {
            const row = this.queryOne<any>(
                `SELECT content, updated_at FROM message_drafts WHERE owner_zalo_id = ? AND thread_id = ?`,
                [ownerZaloId, threadId]
            );
            return row ? { content: row.content, updatedAt: row.updated_at } : null;
        } catch (err: any) {
            Logger.error(`[DB] getDraft error: ${err.message}`);
            return null;
        }
    }

    /** Lấy tất cả drafts cho 1 tài khoản - dùng khi khởi tạo app */
    public getDrafts(ownerZaloId: string): Array<{ threadId: string; content: string; updatedAt: number }> {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT thread_id, content, updated_at FROM message_drafts WHERE owner_zalo_id = ? ORDER BY updated_at DESC`,
                [ownerZaloId]
            ).map(r => ({ threadId: r.thread_id, content: r.content, updatedAt: r.updated_at }));
        } catch (err: any) {
            Logger.error(`[DB] getDrafts error: ${err.message}`);
            return [];
        }
    }

    /** Xoá tất cả draft cũ hơn N ngày - cleanup */
    public deleteOldDrafts(olderThanDays: number = 7): void {
        if (!this.initialized) return;
        try {
            const cutoff = Date.now() - olderThanDays * 86400_000;
            this.run(`DELETE FROM message_drafts WHERE updated_at < ?`, [cutoff]);
        } catch (err: any) {
            Logger.error(`[DB] deleteOldDrafts error: ${err.message}`);
        }
    }

    // ─── Bank Cards ───────────────────────────────────────────────────────

    /** Lấy danh sách thẻ ngân hàng của tài khoản */
    public getBankCards(ownerZaloId: string): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT * FROM bank_cards WHERE owner_zalo_id = ? ORDER BY is_default DESC, created_at DESC`,
                [ownerZaloId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getBankCards error: ${err.message}`);
            return [];
        }
    }

    /** Thêm/sửa thẻ ngân hàng */
    public upsertBankCard(ownerZaloId: string, card: {
        id?: number; bank_name: string; bin_bank: number;
        account_number: string; account_name: string; is_default?: number;
    }): number {
        if (!this.initialized) return -1;
        try {
            const now = Date.now();
            // Nếu đặt mặc định → bỏ default của các thẻ khác
            if (card.is_default) {
                this.run(`UPDATE bank_cards SET is_default = 0 WHERE owner_zalo_id = ?`, [ownerZaloId]);
            }
            if (card.id) {
                this.run(
                    `UPDATE bank_cards SET bank_name=?, bin_bank=?, account_number=?, account_name=?, is_default=?, updated_at=?
                     WHERE id=? AND owner_zalo_id=?`,
                    [card.bank_name, card.bin_bank, card.account_number, card.account_name, card.is_default ?? 0, now, card.id, ownerZaloId]
                );
                return card.id;
            } else {
                this.run(
                    `INSERT INTO bank_cards (owner_zalo_id, bank_name, bin_bank, account_number, account_name, is_default, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?)`,
                    [ownerZaloId, card.bank_name, card.bin_bank, card.account_number, card.account_name, card.is_default ?? 0, now, now]
                );
                const row = this.queryOne<any>(`SELECT last_insert_rowid() as id`);
                return row?.id ?? -1;
            }
        } catch (err: any) {
            Logger.error(`[DB] upsertBankCard error: ${err.message}`);
            return -1;
        }
    }

    /** Xóa thẻ ngân hàng */
    public deleteBankCard(ownerZaloId: string, id: number): void {
        if (!this.initialized) return;
        try {
            this.run(`DELETE FROM bank_cards WHERE id = ? AND owner_zalo_id = ?`, [id, ownerZaloId]);
        } catch (err: any) {
            Logger.error(`[DB] deleteBankCard error: ${err.message}`);
        }
    }

    // ─── Tự động đánh dấu đã đọc ─────────────────────────────────────────

    /**
     * Hội thoại chưa đọc (còn tin chưa đọc hoặc còn dấu @) của 1 tài khoản, lọc theo thời gian tin cuối
     * (ms, bao gồm 2 đầu), mới nhất trước. Dùng cho "Tự động đánh dấu đã đọc".
     */
    public getUnreadConversations(ownerZaloId: string, opts: {
        from?: number; to?: number; includeOthers?: boolean; channel?: string;
    } = {}): Array<{
        contact_id: string; contact_type: string; channel: string; display_name: string; alias: string;
        unread_count: number; has_mention: number; last_message_time: number; is_in_others: number;
        telegram_membership_state: string | null;
    }> {
        if (!this.initialized || !ownerZaloId) return [];
        try {
            const conditions = ['owner_zalo_id = ?', '(unread_count > 0 OR IFNULL(has_mention, 0) = 1)'];
            const params: any[] = [ownerZaloId];
            if (!opts.includeOthers) conditions.push('IFNULL(is_in_others, 0) = 0');
            if (Number.isFinite(opts.from)) { conditions.push('IFNULL(last_message_time, 0) >= ?'); params.push(Number(opts.from)); }
            if (Number.isFinite(opts.to)) { conditions.push('IFNULL(last_message_time, 0) <= ?'); params.push(Number(opts.to)); }
            if (opts.channel && opts.channel !== 'all') { conditions.push("IFNULL(channel, 'zalo') = ?"); params.push(opts.channel); }
            return this.query<any>(
                `SELECT contact_id, contact_type, channel, display_name, alias, unread_count, has_mention,
                        last_message_time, is_in_others, telegram_membership_state
                 FROM contacts WHERE ${conditions.join(' AND ')}
                 ORDER BY last_message_time DESC
                 LIMIT 20000`,
                params,
            );
        } catch (err: any) {
            Logger.error(`[DB] getUnreadConversations error: ${err.message}`);
            return [];
        }
    }

    // ─── Starred messages ("Tin đánh dấu") ───────────────────────────────

    /** (thread_id, msg_id) các tin đang được đánh dấu của 1 tài khoản. */
    public getStarredMessageKeys(ownerZaloId: string): Array<{ thread_id: string; msg_id: string }> {
        if (!this.initialized || !ownerZaloId) return [];
        try {
            return this.query<{ thread_id: string; msg_id: string }>(
                `SELECT thread_id, msg_id FROM starred_messages WHERE owner_zalo_id = ?`,
                [ownerZaloId],
            );
        } catch (err: any) {
            Logger.error(`[DB] getStarredMessageKeys error: ${err.message}`);
            return [];
        }
    }

    /**
     * Tin đánh dấu của các tài khoản, mới đánh dấu trước. Kèm tin nhắn hiện tại (LEFT JOIN - null khi tin đã bị
     * xoá khỏi app, khi đó renderer dùng snapshot), tên/ảnh người gửi và hội thoại.
     */
    public getStarredMessages(ownerZaloIds: string[], limit = 50, offset = 0): any[] {
        const owners = [...new Set((ownerZaloIds || []).map(String).filter(Boolean))].slice(0, 50);
        if (!this.initialized || owners.length === 0) return [];
        try {
            const placeholders = owners.map(() => '?').join(',');
            // CAST(m.thread_id AS TEXT) (giá trị như cũ): `m.thread_id = s.thread_id` làm SQLite chọn idx_messages_thread_cursor
            // và duyệt mọi tin của hội thoại cho MỖI tin đánh dấu (hội thoại 100k tin ~12 ms / dòng); nay tra chỉ mục mã tin.
            return this.query<any>(
                `SELECT s.owner_zalo_id, s.thread_id, s.msg_id, s.starred_at, s.snapshot,
                        m.sender_id, m.content, m.msg_type, m.timestamp, m.attachments, m.local_paths,
                        m.thread_type, m.channel, m.is_sent, m.is_recalled,
                        COALESCE(NULLIF(gm.display_name, ''), NULLIF(sc.alias, ''), NULLIF(sc.display_name, '')) AS sender_name,
                        COALESCE(NULLIF(gm.avatar, ''), NULLIF(sc.avatar_url, '')) AS sender_avatar,
                        c.display_name AS thread_name, c.alias AS thread_alias, c.avatar_url AS thread_avatar,
                        c.contact_type AS thread_contact_type, c.channel AS thread_channel
                 FROM starred_messages s
                 LEFT JOIN messages m ON m.msg_id = s.msg_id AND m.owner_zalo_id = s.owner_zalo_id AND CAST(m.thread_id AS TEXT) = s.thread_id
                 LEFT JOIN contacts c ON c.owner_zalo_id = s.owner_zalo_id AND c.contact_id = s.thread_id
                 LEFT JOIN page_group_member gm ON gm.owner_zalo_id = s.owner_zalo_id AND gm.group_id = s.thread_id AND gm.member_id = m.sender_id
                 LEFT JOIN contacts sc ON sc.owner_zalo_id = s.owner_zalo_id AND sc.contact_id = m.sender_id
                 WHERE s.owner_zalo_id IN (${placeholders})
                 ORDER BY s.starred_at DESC
                 LIMIT ? OFFSET ?`,
                [...owners, Math.max(1, Math.min(500, Number(limit) || 50)), Math.max(0, Number(offset) || 0)],
            );
        } catch (err: any) {
            Logger.error(`[DB] getStarredMessages error: ${err.message}`);
            return [];
        }
    }

    /** Đánh dấu / bỏ đánh dấu 1 tin. `snapshot` (JSON) giữ nội dung để vẫn xem được khi tin bị xoá khỏi app. */
    public setMessageStarred(ownerZaloId: string, threadId: string, msgId: string, starred: boolean, snapshot?: unknown): void {
        if (!this.initialized || !ownerZaloId || !threadId || !msgId) return;
        try {
            if (starred) {
                let snap: string | null = null;
                if (snapshot && typeof snapshot === 'object') {
                    snap = JSON.stringify(snapshot);
                    // Giữ bảng gọn: nội dung quá lớn → bỏ phần nặng, giữ tên / loại / thời gian
                    if (snap.length > 32_000) {
                        const { content, attachments, localPaths, ...light } = snapshot as Record<string, unknown>;
                        void content; void attachments; void localPaths;
                        snap = JSON.stringify(light);
                    }
                } else if (typeof snapshot === 'string' && snapshot.length <= 32_000) {
                    snap = snapshot;
                }
                this.run(
                    `INSERT INTO starred_messages (owner_zalo_id, thread_id, msg_id, starred_at, snapshot) VALUES (?,?,?,?,?)
                     ON CONFLICT(owner_zalo_id, thread_id, msg_id) DO UPDATE SET
                       starred_at = excluded.starred_at,
                       snapshot = COALESCE(excluded.snapshot, starred_messages.snapshot)`,
                    [ownerZaloId, threadId, msgId, Date.now(), snap],
                );
            } else {
                this.run(
                    `DELETE FROM starred_messages WHERE owner_zalo_id = ? AND thread_id = ? AND msg_id = ?`,
                    [ownerZaloId, threadId, msgId],
                );
            }
        } catch (err: any) {
            Logger.error(`[DB] setMessageStarred error: ${err.message}`);
        }
    }

    // ─── Local Pinned Conversations ──────────────────────────────────────

    /** Trả về danh sách threadId đang được ghim cục bộ, sắp xếp mới nhất trước. */
    public getLocalPinnedConversations(ownerZaloId: string): string[] {
        if (!this.initialized) return [];
        try {
            const rows = this.query<{ thread_id: string }>(
                `SELECT thread_id FROM local_pinned_conversations WHERE owner_zalo_id = ? ORDER BY pinned_at DESC`,
                [ownerZaloId],
            );
            return rows.map(r => r.thread_id);
        } catch (err: any) {
            Logger.error(`[DB] getLocalPinnedConversations error: ${err.message}`);
            return [];
        }
    }

    /** Ghim hoặc bỏ ghim một hội thoại cục bộ. */
    public setLocalPinnedConversation(ownerZaloId: string, threadId: string, isPinned: boolean): void {
        if (!this.initialized) return;
        try {
            if (isPinned) {
                this.run(
                    `INSERT OR REPLACE INTO local_pinned_conversations (owner_zalo_id, thread_id, pinned_at) VALUES (?,?,?)`,
                    [ownerZaloId, threadId, Date.now()],
                );
            } else {
                this.run(
                    `DELETE FROM local_pinned_conversations WHERE owner_zalo_id = ? AND thread_id = ?`,
                    [ownerZaloId, threadId],
                );
            }
        } catch (err: any) {
            Logger.error(`[DB] setLocalPinnedConversation error: ${err.message}`);
        }
    }

    // ─── Employee Management ──────────────────────────────────────────────

    public getEmployees(): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT * FROM employees ORDER BY created_at DESC`);
        } catch (err: any) {
            Logger.error(`[DB] getEmployees error: ${err.message}`);
            return [];
        }
    }

    public getEmployeeById(employeeId: string): any | undefined {
        if (!this.initialized) return undefined;
        try {
            return this.queryOne<any>(`SELECT * FROM employees WHERE employee_id = ?`, [employeeId]);
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeById error: ${err.message}`);
            return undefined;
        }
    }

    public getEmployeeByUsername(username: string): any | undefined {
        if (!this.initialized) return undefined;
        try {
            return this.queryOne<any>(`SELECT * FROM employees WHERE username = ?`, [username]);
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeByUsername error: ${err.message}`);
            return undefined;
        }
    }

    public createEmployee(employee: { employee_id: string; username: string; password_hash: string; display_name: string; avatar_url?: string; role?: string }): number {
        if (!this.initialized) return 0;
        try {
            const now = Date.now();
            return this.runInsert(
                `INSERT INTO employees (employee_id, username, password_hash, display_name, avatar_url, role, is_active, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,1,?,?)`,
                [employee.employee_id, employee.username.toLowerCase().trim(), employee.password_hash, employee.display_name, employee.avatar_url || '', employee.role || 'employee', now, now]
            );
        } catch (err: any) {
            Logger.error(`[DB] createEmployee error: ${err.message}`);
            return 0;
        }
    }

    public updateEmployee(employeeId: string, updates: { display_name?: string; avatar_url?: string; password_hash?: string; is_active?: number; role?: string; group_id?: string | null }): void {
        if (!this.initialized) return;
        try {
            const sets: string[] = [];
            const params: any[] = [];
            if (updates.display_name !== undefined) { sets.push('display_name = ?'); params.push(updates.display_name); }
            if (updates.avatar_url !== undefined) { sets.push('avatar_url = ?'); params.push(updates.avatar_url); }
            if (updates.password_hash !== undefined) { sets.push('password_hash = ?'); params.push(updates.password_hash); }
            if (updates.is_active !== undefined) { sets.push('is_active = ?'); params.push(updates.is_active); }
            if (updates.role !== undefined) { sets.push('role = ?'); params.push(updates.role); }
            if (updates.group_id !== undefined) { sets.push('group_id = ?'); params.push(updates.group_id); }
            if (sets.length === 0) return;
            sets.push('updated_at = ?'); params.push(Date.now());
            params.push(employeeId);
            this.run(`UPDATE employees SET ${sets.join(', ')} WHERE employee_id = ?`, params);
        } catch (err: any) {
            Logger.error(`[DB] updateEmployee error: ${err.message}`);
        }
    }

    public deleteEmployee(employeeId: string): void {
        if (!this.initialized) return;
        try {
            this.run(`DELETE FROM employee_permissions WHERE employee_id = ?`, [employeeId]);
            this.run(`DELETE FROM employee_account_access WHERE employee_id = ?`, [employeeId]);
            this.run(`DELETE FROM employee_sessions WHERE employee_id = ?`, [employeeId]);
            this.run(`DELETE FROM employees WHERE employee_id = ?`, [employeeId]);
        } catch (err: any) {
            Logger.error(`[DB] deleteEmployee error: ${err.message}`);
        }
    }

    public updateEmployeeLastLogin(employeeId: string): void {
        if (!this.initialized) return;
        try {
            this.run(`UPDATE employees SET last_login = ? WHERE employee_id = ?`, [Date.now(), employeeId]);
        } catch (err: any) {
            Logger.error(`[DB] updateEmployeeLastLogin error: ${err.message}`);
        }
    }

    // ─── Employee Permissions ──────────────────────────────────────────

    public getEmployeePermissions(employeeId: string): Array<{ module: string; can_access: number }> {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT module, can_access FROM employee_permissions WHERE employee_id = ?`, [employeeId]);
        } catch (err: any) {
            Logger.error(`[DB] getEmployeePermissions error: ${err.message}`);
            return [];
        }
    }

    public setEmployeePermissions(employeeId: string, permissions: Array<{ module: string; can_access: number }>): void {
        if (!this.initialized) return;
        try {
            this.runNoSave(`DELETE FROM employee_permissions WHERE employee_id = ?`, [employeeId]);
            for (const perm of permissions) {
                this.runNoSave(
                    `INSERT INTO employee_permissions (employee_id, module, can_access) VALUES (?,?,?)`,
                    [employeeId, perm.module, perm.can_access ? 1 : 0]
                );
            }
            this.save();
        } catch (err: any) {
            Logger.error(`[DB] setEmployeePermissions error: ${err.message}`);
        }
    }

    // ─── Employee Account Access ──────────────────────────────────────

    public getEmployeeAccountAccess(employeeId: string): string[] {
        if (!this.initialized) return [];
        try {
            return this.query<{ zalo_id: string }>(`SELECT zalo_id FROM employee_account_access WHERE employee_id = ?`, [employeeId]).map(r => r.zalo_id);
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeAccountAccess error: ${err.message}`);
            return [];
        }
    }

    public setEmployeeAccountAccess(employeeId: string, zaloIds: string[]): void {
        if (!this.initialized) return;
        try {
            this.runNoSave(`DELETE FROM employee_account_access WHERE employee_id = ?`, [employeeId]);
            for (const zaloId of zaloIds) {
                this.runNoSave(
                    `INSERT INTO employee_account_access (employee_id, zalo_id) VALUES (?,?)`,
                    [employeeId, zaloId]
                );
            }
            this.save();
        } catch (err: any) {
            Logger.error(`[DB] setEmployeeAccountAccess error: ${err.message}`);
        }
    }

    public getEmployeesForAccount(zaloId: string): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT e.* FROM employees e JOIN employee_account_access ea ON e.employee_id = ea.employee_id WHERE ea.zalo_id = ?`,
                [zaloId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getEmployeesForAccount error: ${err.message}`);
            return [];
        }
    }

    // ─── Employee Message Log ──────────────────────────────────────────

    public logEmployeeAction(params: { employee_id: string; zalo_id: string; thread_id: string; thread_type?: number; msg_id?: string; action: string; metadata?: string }): number {
        if (!this.initialized) return 0;
        try {
            return this.runInsert(
                `INSERT INTO employee_message_log (employee_id, zalo_id, thread_id, thread_type, msg_id, action, metadata, timestamp)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [params.employee_id, params.zalo_id, params.thread_id, params.thread_type || 0, params.msg_id || null, params.action, params.metadata || '{}', Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DB] logEmployeeAction error: ${err.message}`);
            return 0;
        }
    }

    /** Start a new employee session (returns session id) */
    public startEmployeeSession(employeeId: string, ipAddress: string, machineName?: string): number {
        if (!this.initialized) return 0;
        try {
            return this.runInsert(
                `INSERT INTO employee_sessions (employee_id, machine_name, ip_address, connected_at) VALUES (?,?,?,?)`,
                [employeeId, machineName || '', ipAddress || '', Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DB] startEmployeeSession error: ${err.message}`);
            return 0;
        }
    }

    /** End an employee session (set disconnected_at) */
    public endEmployeeSession(employeeId: string): void {
        if (!this.initialized) return;
        try {
            // Close all open sessions for this employee
            this.run(
                `UPDATE employee_sessions SET disconnected_at = ? WHERE employee_id = ? AND disconnected_at IS NULL`,
                [Date.now(), employeeId]
            );
        } catch (err: any) {
            Logger.error(`[DB] endEmployeeSession error: ${err.message}`);
        }
    }

    /**
     * @param zaloIds only activity on these accounts (Reports account filter); omitted = every account.
     *                Online hours come from login sessions, which are not per account, and ignore it.
     */
    public getEmployeeStats(employeeId: string, sinceTs?: number, untilTs?: number, zaloIds?: string[] | null): any {
        if (!this.initialized) return {};
        try {
            const since = sinceTs || 0;
            const until = untilTs || Date.now();
            const acc = employeeLogAccountFilter(zaloIds);
            const sent = this.queryOne<any>(
                `SELECT COUNT(*) as count FROM employee_message_log WHERE employee_id = ? AND action = 'sent' AND timestamp >= ? AND timestamp <= ?${acc.sql}`,
                [employeeId, since, until, ...acc.params]
            );
            const conversations = this.queryOne<any>(
                `SELECT COUNT(DISTINCT thread_id) as count FROM employee_message_log WHERE employee_id = ? AND timestamp >= ? AND timestamp <= ?${acc.sql}`,
                [employeeId, since, until, ...acc.params]
            );
            const avgResponse = this.queryOne<any>(
                `SELECT AVG(CAST(json_extract(metadata, '$.response_time_ms') AS REAL)) as avg_ms
                 FROM employee_message_log WHERE employee_id = ? AND action = 'replied'
                 AND json_extract(metadata, '$.response_time_ms') IS NOT NULL
                 AND timestamp >= ? AND timestamp <= ?${acc.sql}`,
                [employeeId, since, until, ...acc.params]
            );
            // Include sessions that OVERLAP with the [since, until] window
            // (not just sessions that started within the window)
            const sessions = this.query<any>(
                `SELECT connected_at, disconnected_at FROM employee_sessions
                 WHERE employee_id = ? AND connected_at <= ? AND (disconnected_at >= ? OR disconnected_at IS NULL)`,
                [employeeId, until, since]
            );
            let totalOnlineMs = 0;
            for (const s of sessions) {
                const start = Math.max(s.connected_at, since);
                const end = Math.min(s.disconnected_at || Date.now(), until);
                if (end > start) totalOnlineMs += (end - start);
            }
            return {
                messages_sent: sent?.count || 0,
                conversations_handled: conversations?.count || 0,
                avg_response_time_ms: avgResponse?.avg_ms || 0,
                total_online_hours: Math.round((totalOnlineMs / 3600000) * 10) / 10,
            };
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeStats error: ${err.message}`);
            return {};
        }
    }

    public getEmployeeSessions(employeeId: string, limit: number = 50): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT * FROM employee_sessions WHERE employee_id = ? ORDER BY connected_at DESC LIMIT ?`,
                [employeeId, limit]
            );
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeSessions error: ${err.message}`);
            return [];
        }
    }

    // ─── Employee Groups ──────────────────────────────────────────────

    public getEmployeeGroups(): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(`SELECT * FROM employee_groups ORDER BY sort_order ASC, created_at ASC`);
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeGroups error: ${err.message}`);
            return [];
        }
    }

    public createEmployeeGroup(params: { group_id: string; name: string; color?: string }): void {
        if (!this.initialized) return;
        try {
            this.run(
                `INSERT INTO employee_groups (group_id, name, color, sort_order, created_at) VALUES (?,?,?,?,?)`,
                [params.group_id, params.name, params.color || '', 0, Date.now()]
            );
        } catch (err: any) {
            Logger.error(`[DB] createEmployeeGroup error: ${err.message}`);
        }
    }

    public updateEmployeeGroup(groupId: string, updates: { name?: string; color?: string; sort_order?: number }): void {
        if (!this.initialized) return;
        try {
            const sets: string[] = [];
            const params: any[] = [];
            if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
            if (updates.color !== undefined) { sets.push('color = ?'); params.push(updates.color); }
            if (updates.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(updates.sort_order); }
            if (sets.length === 0) return;
            params.push(groupId);
            this.run(`UPDATE employee_groups SET ${sets.join(', ')} WHERE group_id = ?`, params);
        } catch (err: any) {
            Logger.error(`[DB] updateEmployeeGroup error: ${err.message}`);
        }
    }

    public deleteEmployeeGroup(groupId: string): void {
        if (!this.initialized) return;
        try {
            // Unset group_id for employees in this group
            this.run(`UPDATE employees SET group_id = NULL WHERE group_id = ?`, [groupId]);
            this.run(`DELETE FROM employee_groups WHERE group_id = ?`, [groupId]);
        } catch (err: any) {
            Logger.error(`[DB] deleteEmployeeGroup error: ${err.message}`);
        }
    }

    // ─── Employee Analytics (Advanced) ──────────────────────────────

    /**
     * Get message volume per employee per day (for timeline charts)
     * @param zaloIds only activity on these accounts; omitted = every account.
     */
    public getEmployeeMessageTimeline(sinceTs: number, untilTs: number, zaloIds?: string[] | null): any[] {
        if (!this.initialized) return [];
        try {
            const acc = employeeLogAccountFilter(zaloIds);
            // day_index = local calendar days since the day of sinceTs
            // (EmployeeAnalyticsTab labels it with addLocalDays(sinceTs, day_index)).
            return this.query<any>(
                `SELECT
                    employee_id,
                    CAST(julianday(${sqlLocalDay('timestamp')}) - julianday(?) AS INTEGER) as day_index,
                    COUNT(*) as count,
                    SUM(CASE WHEN action = 'sent' THEN 1 ELSE 0 END) as sent,
                    SUM(CASE WHEN action = 'received' THEN 1 ELSE 0 END) as received
                 FROM employee_message_log
                 WHERE timestamp >= ? AND timestamp <= ?${acc.sql}
                 GROUP BY employee_id, day_index
                 ORDER BY day_index ASC`,
                [localDayKey(sinceTs), sinceTs, untilTs, ...acc.params]
            );
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeMessageTimeline error: ${err.message}`);
            return [];
        }
    }

    /**
     * Get online hours breakdown per employee per day
     */
    public getEmployeeOnlineTimeline(sinceTs: number, untilTs: number): any[] {
        if (!this.initialized) return [];
        try {
            const sessions = this.query<any>(
                `SELECT es.employee_id, es.connected_at, es.disconnected_at
                 FROM employee_sessions es
                 WHERE es.connected_at <= ? AND (es.disconnected_at >= ? OR es.disconnected_at IS NULL)
                 ORDER BY es.connected_at ASC`,
                [untilTs, sinceTs]
            );

            // Build per-employee per-day hours (day 0 = the local calendar day of sinceTs)
            const result: any[] = [];
            const map = new Map<string, Map<number, number>>(); // employeeId -> dayIndex -> ms

            for (const s of sessions) {
                const start = Math.max(s.connected_at, sinceTs);
                const end = Math.min(s.disconnected_at || Date.now(), untilTs);
                if (end <= start) continue;

                if (!map.has(s.employee_id)) map.set(s.employee_id, new Map());
                const empMap = map.get(s.employee_id)!;

                // Split at local midnights
                let cursor = start;
                while (cursor < end) {
                    const dayIdx = localDayDiff(sinceTs, cursor);
                    const segmentEnd = Math.min(end, addLocalDays(cursor, 1));
                    empMap.set(dayIdx, (empMap.get(dayIdx) || 0) + (segmentEnd - cursor));
                    cursor = segmentEnd;
                }
            }

            for (const [employee_id, dayMap] of map) {
                for (const [day_index, ms] of dayMap) {
                    result.push({
                        employee_id,
                        day_index,
                        online_hours: Math.round((ms / 3600000) * 10) / 10,
                    });
                }
            }
            return result;
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeOnlineTimeline error: ${err.message}`);
            return [];
        }
    }

    /**
     * Get response time distribution for all employees (buckets: <1m, 1-5m, 5-15m, 15-30m, 30-60m, 1-4h, 4-24h, >24h)
     * @param zaloIds only replies on these accounts; omitted = every account.
     */
    public getEmployeeResponseDistribution(sinceTs: number, untilTs: number, zaloIds?: string[] | null): any[] {
        if (!this.initialized) return [];
        try {
            const acc = employeeLogAccountFilter(zaloIds);
            const rows = this.query<any>(
                `SELECT employee_id,
                    CAST(json_extract(metadata, '$.response_time_ms') AS REAL) as rt_ms
                 FROM employee_message_log
                 WHERE action = 'replied'
                   AND json_extract(metadata, '$.response_time_ms') IS NOT NULL
                   AND timestamp >= ? AND timestamp <= ?${acc.sql}`,
                [sinceTs, untilTs, ...acc.params]
            );

            const buckets = ['<1m', '1-5m', '5-15m', '15-30m', '30-60m', '1-4h', '4-24h', '>24h'];
            const empBuckets = new Map<string, number[]>();

            for (const row of rows) {
                if (!empBuckets.has(row.employee_id)) {
                    empBuckets.set(row.employee_id, new Array(8).fill(0));
                }
                const b = empBuckets.get(row.employee_id)!;
                const ms = row.rt_ms;
                if (ms < 60000) b[0]++;
                else if (ms < 300000) b[1]++;
                else if (ms < 900000) b[2]++;
                else if (ms < 1800000) b[3]++;
                else if (ms < 3600000) b[4]++;
                else if (ms < 14400000) b[5]++;
                else if (ms < 86400000) b[6]++;
                else b[7]++;
            }

            const result: any[] = [];
            for (const [employee_id, counts] of empBuckets) {
                buckets.forEach((bucket, i) => {
                    if (counts[i] > 0) result.push({ employee_id, bucket, count: counts[i] });
                });
            }
            return result;
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeResponseDistribution error: ${err.message}`);
            return [];
        }
    }

    /**
     * Get hourly activity pattern for employees (which hours they are most active)
     * @param zaloIds only activity on these accounts; omitted = every account.
     */
    public getEmployeeHourlyActivity(sinceTs: number, untilTs: number, zaloIds?: string[] | null): any[] {
        if (!this.initialized) return [];
        try {
            const acc = employeeLogAccountFilter(zaloIds);
            return this.query<any>(
                `SELECT
                    employee_id,
                    CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
                    COUNT(*) as count
                 FROM employee_message_log
                 WHERE timestamp >= ? AND timestamp <= ?${acc.sql}
                 GROUP BY employee_id, hour
                 ORDER BY hour ASC`,
                [sinceTs, untilTs, ...acc.params]
            );
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeHourlyActivity error: ${err.message}`);
            return [];
        }
    }

    /**
     * Comprehensive all-employees comparison for a date range
     * @param zaloIds only activity on these accounts (online hours stay per session); omitted = every account.
     */
    public getEmployeeComparison(sinceTs: number, untilTs: number, zaloIds?: string[] | null): any[] {
        if (!this.initialized) return [];
        try {
            const employees = this.query<any>(
                `SELECT employee_id, display_name, avatar_url, role, is_active, group_id FROM employees ORDER BY display_name ASC`
            );

            return employees.map((emp: any) => {
                const stats = this.getEmployeeStats(emp.employee_id, sinceTs, untilTs, zaloIds);
                return {
                    employee_id: emp.employee_id,
                    display_name: emp.display_name,
                    avatar_url: emp.avatar_url || '',
                    role: emp.role,
                    is_active: emp.is_active,
                    group_id: emp.group_id,
                    messages_sent: stats.messages_sent || 0,
                    conversations_handled: stats.conversations_handled || 0,
                    avg_response_time_ms: stats.avg_response_time_ms || 0,
                    total_online_hours: stats.total_online_hours || 0,
                };
            });
        } catch (err: any) {
            Logger.error(`[DB] getEmployeeComparison error: ${err.message}`);
            return [];
        }
    }

    // ─── Facebook Integration Methods ────────────────────────────────────────────

    // ── FB Accounts ──

    public saveFBAccount(account: {
        id: string; facebook_id: string; name: string; avatar_url: string;
        cookie_encrypted: string; session_data: string; status: string;
    }): void {
        const now = Date.now();
        this.run(`
            INSERT INTO fb_accounts (id, facebook_id, name, avatar_url, cookie_encrypted, session_data, status, last_cookie_check, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              facebook_id = excluded.facebook_id, name = excluded.name, avatar_url = excluded.avatar_url,
              cookie_encrypted = excluded.cookie_encrypted, session_data = excluded.session_data,
              status = excluded.status, updated_at = excluded.updated_at
        `, [account.id, account.facebook_id, account.name, account.avatar_url,
            account.cookie_encrypted, account.session_data, account.status, now, now, now]);
    }

    public getFBAccounts(): any[] {
        return this.query<any>(`SELECT * FROM fb_accounts ORDER BY created_at ASC`);
    }

    public getFBAccount(id: string): any | undefined {
        return this.queryOne<any>(`SELECT * FROM fb_accounts WHERE id = ?`, [id]);
    }

    public getFBAccountByFacebookId(facebookId: string): any | undefined {
        return this.queryOne<any>(`SELECT * FROM fb_accounts WHERE facebook_id = ?`, [facebookId]);
    }

    public updateFBAccountStatus(id: string, status: string): void {
        this.run(`UPDATE fb_accounts SET status = ?, updated_at = ? WHERE id = ?`, [status, Date.now(), id]);
    }

    public updateFBAccountSession(id: string, sessionData: string): void {
        this.run(`UPDATE fb_accounts SET session_data = ?, last_cookie_check = ?, updated_at = ? WHERE id = ?`,
            [sessionData, Date.now(), Date.now(), id]);
    }

    public updateFBAccountProfile(id: string, name: string, avatarUrl: string, facebookId: string): void {
        this.run(`UPDATE fb_accounts SET name = ?, avatar_url = ?, facebook_id = ?, updated_at = ? WHERE id = ?`,
            [name, avatarUrl, facebookId, Date.now(), id]);
    }

    /**
     * Gỡ tài khoản Facebook nhưng GIỮ dữ liệu (như Zalo / Telegram): chỉ xoá phiên đăng nhập của hàng fb_accounts —
     * cookie thô (cookie_encrypted) và session_data. Kết nối lại (reconnectAllFBAccounts, getFBServiceOrReconnect) lấy
     * cookie thô làm dự phòng, nên còn cookie là tài khoản đã gỡ tự kết nối lại. Hàng fb_accounts ở lại: hội thoại /
     * tin nhắn / liên hệ CRM gắn theo ID nội bộ, đăng nhập lại đúng tài khoản thì _addFBAccountCommon (tìm theo
     * facebook_id) dùng lại ID đó. Xoá cả dữ liệu: deleteAccountData (Cài đặt → Tài khoản → "Xoá tất cả dữ liệu").
     */
    public clearFBAccountSession(id: string): void {
        this.run(`UPDATE fb_accounts SET cookie_encrypted = '', session_data = '', status = 'disconnected', updated_at = ? WHERE id = ?`,
            [Date.now(), id]);
    }

    // ── FB Threads ──

    public saveFBThread(thread: {
        id: string; account_id: string; name: string; type: string;
        emoji?: string; participant_count: number; last_message_preview?: string;
        last_message_at?: number; unread_count: number; is_muted: number;
        is_e2ee?: number;
        metadata?: Record<string, any>;
    }, options?: { preserveUnread?: boolean }): void {
        const now = Date.now();
        const metadata = thread.metadata && Object.keys(thread.metadata).length > 0
            ? JSON.stringify(thread.metadata)
            : null;
        this.run(`
            INSERT INTO fb_threads (id, account_id, name, type, emoji, participant_count,
                last_message_preview, last_message_at, unread_count, is_muted, is_e2ee, metadata, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = CASE WHEN excluded.name != '' THEN excluded.name ELSE fb_threads.name END,
              type = excluded.type, emoji = excluded.emoji,
              participant_count = excluded.participant_count,
              last_message_preview = excluded.last_message_preview,
              last_message_at = excluded.last_message_at,
              unread_count = ${options?.preserveUnread ? 'fb_threads.unread_count' : 'excluded.unread_count'},
              is_muted = ${options?.preserveUnread ? 'fb_threads.is_muted' : 'excluded.is_muted'},
              is_e2ee = CASE WHEN excluded.is_e2ee = 1 THEN 1 ELSE fb_threads.is_e2ee END,
              metadata = CASE WHEN excluded.metadata IS NOT NULL AND excluded.metadata != '' THEN excluded.metadata ELSE fb_threads.metadata END,
              synced_at = excluded.synced_at
        `, [thread.id, thread.account_id, thread.name, thread.type, thread.emoji || null,
            thread.participant_count, thread.last_message_preview || null,
            thread.last_message_at || null, thread.unread_count, thread.is_muted,
            thread.is_e2ee ?? 0, metadata, now]);
    }

    /** Đánh dấu thread là E2EE-encrypted */
    public markFBThreadE2EE(threadId: string, accountId: string): void {
        this.run(`UPDATE fb_threads SET is_e2ee = 1 WHERE id = ? AND account_id = ?`, [threadId, accountId]);
    }

    /** Lấy danh sách thread IDs đã mã hoá E2EE của account */
    public getE2EEThreadIds(accountId: string): string[] {
        const rows = this.query<{ id: string }>(
            `SELECT id FROM fb_threads WHERE account_id = ? AND is_e2ee = 1`, [accountId]
        );
        return rows.map(r => r.id);
    }

    /**
     * Save Facebook threads. Bridge history has no read-state field, so it may
     * refresh names/messages but must preserve local unread state until the
     * GraphQL inbox returns an authoritative count.
     */
    public saveFBThreads(accountId: string, threads: any[], options?: { preserveUnread?: boolean }): void {
        // Resolve facebook_id (numeric UID) for unified contacts table
        // accountId here is internal UUID, but contacts.owner_zalo_id uses facebook_id
        let ownerZaloId = accountId;
        try {
            const fbAcc = this.queryOne<any>(`SELECT facebook_id FROM fb_accounts WHERE id = ?`, [accountId]);
            if (fbAcc?.facebook_id) ownerZaloId = fbAcc.facebook_id;
        } catch {}

        for (const t of threads) {
            this.saveFBThread({
                id: t.id, account_id: accountId, name: t.name, type: t.type,
                emoji: t.emoji, participant_count: t.participant_count || 0,
                last_message_preview: t.last_message_preview,
                last_message_at: t.last_message_at, unread_count: t.unread_count || 0,
                is_muted: t.is_muted ? 1 : 0,
                is_e2ee: t.is_e2ee,
                metadata: t.metadata,
            }, options);
            const avatarUrl = t.metadata?.avatar_url || '';
            // Sync to unified contacts table - use facebook_id as owner_zalo_id
            this.run(`
                INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'facebook')
                ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                  display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE contacts.display_name END,
                  avatar_url = CASE
                    WHEN excluded.avatar_url != '' AND (contacts.avatar_url IS NULL OR contacts.avatar_url = '' OR contacts.avatar_url NOT LIKE 'media/%')
                    THEN excluded.avatar_url
                    ELSE contacts.avatar_url
                  END,
                  contact_type = excluded.contact_type,
                  last_message = CASE WHEN excluded.last_message_time > COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
                  last_message_time = MAX(COALESCE(contacts.last_message_time, 0), excluded.last_message_time),
                  unread_count = ${options?.preserveUnread ? 'contacts.unread_count' : 'excluded.unread_count'},
                  channel = 'facebook'
            `, [ownerZaloId, t.id, t.name || '', avatarUrl, t.type === 'group' ? 'group' : 'user',
                t.unread_count || 0, t.last_message_preview || '', t.last_message_at || 0]);
        }
    }

    public getFBThreads(accountId: string): any[] {
        return this.query<any>(
            `SELECT * FROM fb_threads WHERE account_id = ? ORDER BY last_message_at DESC NULLS LAST`,
            [accountId]
        );
    }

    public updateFBThreadUnread(accountId: string, threadId: string, count: number): void {
        this.run(`UPDATE fb_threads SET unread_count = ? WHERE id = ? AND account_id = ?`,
            [count, threadId, accountId]);
    }

    public markFBThreadAsRead(accountId: string, threadId: string): void {
        this.run(`UPDATE fb_threads SET unread_count = 0 WHERE id = ? AND account_id = ?`,
            [threadId, accountId]);
    }

    // ── FB Messages ──

    public saveFBMessage(msg: {
        id: string; account_id: string; thread_id: string; sender_id: string;
        sender_name?: string; body?: string; timestamp: number; type: string;
        attachments?: string; reply_to_id?: string; is_self: number; is_unsent: number;
        reactions?: string;
        /** Historical backfill must never create a new unread notification. */
        is_history?: boolean;
    }): FbSaveOutcome {
        const now = Date.now();
        let repaired = false;
        // `INSERT OR IGNORE` below makes message persistence idempotent, but
        // the preview/contact work used to run even when the row already
        // existed. Replayed MQTT events then produced a second unread badge.
        let isNewMessage = true;
        try {
            isNewMessage = !this.queryOne<{ id: string }>(
                `SELECT id FROM fb_messages WHERE id = ? AND account_id = ? LIMIT 1`,
                [msg.id, msg.account_id],
            );
        } catch (err: any) {
            Logger.warn(`[DB:saveFBMessage] Could not check duplicate message: ${err.message}`);
        }
        Logger.log(`[DB:saveFBMessage] id=${msg.id} account_id=${msg.account_id} thread_id=${msg.thread_id} sender=${msg.sender_id} is_self=${msg.is_self} type=${msg.type} body="${(msg.body || '').slice(0,50)}" reply_to_id=${msg.reply_to_id || '(none)'}`);
        if (msg.type === 'sticker') {
          Logger.log(`[DB:saveFBMessage] [STICKER] Saving sticker msg: id=${msg.id} thread_id=${msg.thread_id} attachments=${(msg.attachments || '').slice(0,200)}`);
        }

        // If this message is a reply, look up the original message content for quote_data
        let quoteData: string | undefined;
        if (msg.reply_to_id) {
          try {
            const orig = this.queryOne<any>(`SELECT body, type FROM fb_messages WHERE id = ? AND account_id = ?`, [msg.reply_to_id, msg.account_id]);
            if (orig) {
              quoteData = JSON.stringify({
                msgId: msg.reply_to_id,
                msg: orig.body || '',
                senderId: '',
                msgType: orig.type || 'text',
              });
              Logger.log(`[DB:saveFBMessage] Resolved reply_to_id=${msg.reply_to_id} → content="${(orig.body || '').slice(0,50)}"`);
            } else {
              Logger.log(`[DB:saveFBMessage] reply_to_id=${msg.reply_to_id} not found in fb_messages, will try unified messages table`);
              // Fallback: try unified messages table
              const orig2 = this.queryOne<any>(`SELECT content, msg_type FROM messages WHERE msg_id = ?`, [msg.reply_to_id]);
              if (orig2) {
                quoteData = JSON.stringify({
                  msgId: msg.reply_to_id,
                  msg: orig2.content || '',
                  senderId: '',
                  msgType: orig2.msg_type || 'text',
                });
              }
            }
          } catch (e: any) {
            Logger.warn(`[DB:saveFBMessage] reply_to_id lookup error: ${e.message}`);
          }
        }

        this.run(`
            INSERT OR IGNORE INTO fb_messages
              (id, account_id, thread_id, sender_id, sender_name, body, timestamp, type,
               attachments, reply_to_id, is_self, is_unsent, reactions, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [msg.id, msg.account_id, msg.thread_id, msg.sender_id, msg.sender_name || '',
            msg.body || null, msg.timestamp, msg.type, msg.attachments || '[]',
            msg.reply_to_id || null, msg.is_self, msg.is_unsent, msg.reactions || '{}', now]);

        // Also save to unified messages table - use facebook_id as owner_zalo_id
        let ownerZaloId = msg.account_id;
        try {
            const fbAcc = this.queryOne<any>(`SELECT facebook_id FROM fb_accounts WHERE id = ?`, [msg.account_id]);
            Logger.log(`[DB:saveFBMessage] Resolved fbAcc: ${JSON.stringify(fbAcc)} → ownerZaloId will be: ${fbAcc?.facebook_id || msg.account_id}`);
            if (fbAcc?.facebook_id) ownerZaloId = fbAcc.facebook_id;
        } catch (e: any) {
            Logger.warn(`[DB:saveFBMessage] Failed to resolve facebook_id: ${e.message}`);
        }
        Logger.log(`[DB:saveFBMessage] INSERT INTO messages: msg_id=${msg.id} owner_zalo_id=${ownerZaloId} thread_id=${msg.thread_id} is_sent=${msg.is_self} channel=facebook`);
        // Generate display content for unified messages table when body is empty
        const displayContent = msg.body || (() => {
            if (msg.type === 'image' || msg.type === 'photo') return '🖼️ Hình ảnh';
            if (msg.type === 'video') return '🎬 Video';
            if (msg.type === 'audio') return '🎵 Audio';
            if (msg.type === 'sticker') return '🎨 Sticker';
            // Tin mẫu của Page: chữ của thẻ (tiêu đề, mô tả…) — không bao giờ để rỗng
            if (msg.type === FB_TEMPLATE_MSG_TYPE) {
                return fbTemplateText(fbTemplateFromAttachments(msg.attachments)) || '📎 Tin nhắn mẫu';
            }
            if (msg.type !== 'text') {
                try {
                    const atts = JSON.parse(msg.attachments || '[]');
                    const name = atts[0]?.name;
                    return name ? `📎 ${name}` : '📎 Tệp đính kèm';
                } catch { return '📎 Tệp đính kèm'; }
            }
            return '';
        })();
        // Hàng messages vừa chèn (kể cả khi fb_messages đã có) cũng tính là tin mới với người gọi
        const insertedUnified = this.runChanges(`
            INSERT OR IGNORE INTO messages
              (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel, reply_to_id, quote_data)
            VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'facebook', ?, ?)
        `, [msg.id, ownerZaloId, msg.thread_id, msg.sender_id,
            displayContent, msg.type || 'text', msg.timestamp,
            msg.is_self, msg.attachments || '[]', msg.is_self ? 'sent' : 'received',
            msg.reply_to_id || null, quoteData || null]);

        // Hàng đã có nhưng còn rỗng (tin mẫu / đính kèm mà bản cũ chưa đọc được; MQTT và bridge cùng nhận một tin, bên
        // ghi trước thắng) → lần nhận / đồng bộ sau có dữ liệu thì sửa lại. Chỉ đụng hàng còn rỗng, chưa thu hồi; hàng
        // vừa chèn hoặc đã có nội dung không đổi (điều kiện WHERE).
        const newAttachments = msg.attachments || '[]';
        const hasNewAttachments = !['', '[]', 'null'].includes(newAttachments);
        if (!msg.is_unsent && (displayContent || hasNewAttachments)) {
            try {
                const filled = this.runChanges(`
                    UPDATE messages SET content = ?, msg_type = ?, attachments = ?
                    WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook'
                      AND COALESCE(is_recalled, 0) = 0 AND COALESCE(content, '') = ''
                      AND COALESCE(attachments, '[]') IN ('', '[]', 'null')
                `, [displayContent, msg.type || 'text', newAttachments, msg.id, ownerZaloId, msg.thread_id]);
                if (filled > 0 && !isNewMessage) repaired = true;
                this.run(`
                    UPDATE fb_messages SET body = ?, type = ?, attachments = ?
                    WHERE id = ? AND account_id = ? AND COALESCE(is_unsent, 0) = 0 AND COALESCE(body, '') = ''
                      AND COALESCE(attachments, '[]') IN ('', '[]', 'null')
                `, [msg.body || null, msg.type, newAttachments, msg.id, msg.account_id]);
                // Xem trước của hội thoại lấy từ chính tin này mà đang "[Tệp đính kèm]" / rỗng → chữ thật
                if (displayContent) {
                    this.run(`
                        UPDATE contacts SET last_message = ?
                        WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'
                          AND last_message_time <= ? AND COALESCE(last_message, '') IN ('', '[Tệp đính kèm]')
                    `, [displayContent.slice(0, 200), ownerZaloId, msg.thread_id, msg.timestamp]);
                }
            } catch (err: any) {
                Logger.warn(`[DB:saveFBMessage] repair empty row error: ${err.message}`);
            }
        }
        // Tin mẫu đã lưu là thẻ thay thế "File đính kèm không hiển thị" (MQTT tới trước) hoặc chỉ có chữ, bản tới sau (bridge
        // LightSpeed, đồng bộ lúc mở app) có nút / ảnh / link → thay bằng bản đầy đủ. Không bao giờ ngược lại
        // (shouldUpgradeFbTemplate).
        if (!isNewMessage && !msg.is_unsent && msg.type === FB_TEMPLATE_MSG_TYPE) {
            try {
                const stored = this.queryOne<{ content?: string; msg_type?: string; attachments?: string; is_recalled?: number }>(
                    `SELECT content, msg_type, attachments, is_recalled FROM messages
                     WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook' LIMIT 1`,
                    [msg.id, ownerZaloId, msg.thread_id],
                );
                if (stored && !stored.is_recalled && stored.msg_type === FB_TEMPLATE_MSG_TYPE
                    && shouldUpgradeFbTemplate(fbTemplateFromAttachments(stored.attachments), fbTemplateFromAttachments(newAttachments))) {
                    this.run(`
                        UPDATE messages SET content = ?, attachments = ?
                        WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook'
                    `, [displayContent, newAttachments, msg.id, ownerZaloId, msg.thread_id]);
                    this.run(`UPDATE fb_messages SET body = ?, attachments = ? WHERE id = ? AND account_id = ?`,
                        [msg.body || displayContent || null, newAttachments, msg.id, msg.account_id]);
                    // Xem trước của hội thoại đang là chữ của thẻ thay thế (tin này là tin mới nhất) → chữ thật
                    const oldPreview = String(stored.content || '').slice(0, 200);
                    if (displayContent && oldPreview) {
                        this.run(`
                            UPDATE contacts SET last_message = ?
                            WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook' AND last_message = ?
                        `, [displayContent.slice(0, 200), ownerZaloId, msg.thread_id, oldPreview]);
                        this.run(`UPDATE fb_threads SET last_message_preview = ? WHERE id = ? AND account_id = ? AND last_message_preview = ?`,
                            [displayContent.slice(0, 200), msg.thread_id, msg.account_id, oldPreview]);
                    }
                    Logger.log(`[DB:saveFBMessage] template upgraded: id=${msg.id} thread_id=${msg.thread_id}`);
                    repaired = true;
                }
            } catch (err: any) {
                Logger.warn(`[DB:saveFBMessage] upgrade template row error: ${err.message}`);
            }
        }
        // Thẻ thay thế "File đính kèm không hiển thị" (MQTT tới trước) mà bản tới sau là chữ thật không kèm thẻ (bridge cũ
        // chưa ghép nút của tin "chữ + nút") → thay bằng chữ: có nội dung đọc được thay vì "Tin nhắn chưa hiển thị được".
        if (!isNewMessage && !msg.is_unsent && msg.type !== FB_TEMPLATE_MSG_TYPE && msg.type !== 'system' && displayContent && !repaired) {
            try {
                const stored = this.queryOne<{ content?: string; msg_type?: string; attachments?: string; is_recalled?: number }>(
                    `SELECT content, msg_type, attachments, is_recalled FROM messages
                     WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook' LIMIT 1`,
                    [msg.id, ownerZaloId, msg.thread_id],
                );
                if (stored && !stored.is_recalled && stored.msg_type === FB_TEMPLATE_MSG_TYPE
                    && isFbUnavailableTemplate(fbTemplateFromAttachments(stored.attachments))) {
                    this.run(`
                        UPDATE messages SET content = ?, msg_type = ?, attachments = ?
                        WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook'
                    `, [displayContent, msg.type || 'text', newAttachments, msg.id, ownerZaloId, msg.thread_id]);
                    this.run(`UPDATE fb_messages SET body = ?, type = ?, attachments = ? WHERE id = ? AND account_id = ?`,
                        [msg.body || displayContent, msg.type || 'text', newAttachments, msg.id, msg.account_id]);
                    const oldPreview = String(stored.content || '').slice(0, 200);
                    if (oldPreview) {
                        this.run(`
                            UPDATE contacts SET last_message = ?
                            WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook' AND last_message = ?
                        `, [displayContent.slice(0, 200), ownerZaloId, msg.thread_id, oldPreview]);
                        this.run(`UPDATE fb_threads SET last_message_preview = ? WHERE id = ? AND account_id = ? AND last_message_preview = ?`,
                            [displayContent.slice(0, 200), msg.thread_id, msg.account_id, oldPreview]);
                    }
                    Logger.log(`[DB:saveFBMessage] template placeholder replaced by text: id=${msg.id} thread_id=${msg.thread_id}`);
                    repaired = true;
                }
            } catch (err: any) {
                Logger.warn(`[DB:saveFBMessage] replace placeholder with text error: ${err.message}`);
            }
        }
        // Tin đã thu hồi trong lịch sử (bridge / GraphQL): hiện "đã thu hồi" thay vì bong bóng rỗng
        if (msg.is_unsent) {
            this.run(`
                UPDATE messages SET is_recalled = 1, content = ''
                WHERE msg_id = ? AND owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook' AND COALESCE(is_recalled, 0) = 0
            `, [msg.id, ownerZaloId, msg.thread_id]);
        }

        // Update thread preview + contacts (unified conversation list).
        // A bridge/API history sync calls this method to persist old rows too;
        // those rows are not new notifications and must not re-increment unread
        // counts every time the application starts.
        if (!msg.is_unsent && !msg.is_history && isNewMessage) {
            const lastMsgPreview = msg.body?.slice(0, 200) || (msg.type === FB_TEMPLATE_MSG_TYPE && displayContent ? displayContent.slice(0, 200) : msg.type === 'image' ? '🖼️ Hình ảnh' : msg.type === 'video' ? '🎬 Video' : msg.type === 'audio' ? '🎵 Audio' : msg.type === 'sticker' ? '🎨 Sticker' : '[Tệp đính kèm]');
            this.run(`
                UPDATE fb_threads SET last_message_preview = ?, last_message_at = ?,
                  unread_count = unread_count + ?
                WHERE id = ? AND account_id = ?
            `, [lastMsgPreview, msg.timestamp,
                msg.is_self ? 0 : 1, msg.thread_id, msg.account_id]);

            // Update unified contacts table (used by left-side conversation list)
            // Mirror logic from FacebookService.handleIncomingMessage
            try {
                const fbThread = this.queryOne<any>(
                    `SELECT name, type, metadata FROM fb_threads WHERE id = ? AND account_id = ?`,
                    [msg.thread_id, msg.account_id]
                );
                let threadName = fbThread?.name || '';
                const contactType = fbThread?.type === 'group' ? 'group' : 'user';

                // For 1:1 contacts with no name (e.g. newly discovered E2EE thread),
                // try to resolve from existing contacts table
                if (!threadName && contactType === 'user') {
                    const existing = this.queryOne<any>(
                        `SELECT display_name FROM contacts
                         WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook' AND display_name != '' LIMIT 1`,
                        [ownerZaloId, msg.thread_id]
                    );
                    if (existing?.display_name) threadName = existing.display_name;
                }
                const avatarUrl = fbThread?.metadata
                    ? (() => { try { return JSON.parse(fbThread.metadata)?.avatar_url || ''; } catch { return ''; } })()
                    : '';
                this.run(`
                    INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
                    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'facebook')
                    ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                      display_name = CASE WHEN excluded.display_name != '' AND contacts.display_name = '' THEN excluded.display_name ELSE contacts.display_name END,
                      avatar_url = CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE contacts.avatar_url END,
                      last_message = excluded.last_message,
                      last_message_time = excluded.last_message_time,
                      unread_count = CASE WHEN ? = 0 THEN contacts.unread_count + 1 ELSE contacts.unread_count END,
                      channel = 'facebook'
                `, [ownerZaloId, msg.thread_id, threadName, avatarUrl, contactType,
                    msg.is_self ? 0 : 1, lastMsgPreview, msg.timestamp, msg.is_self]);
            } catch (err: any) {
                Logger.warn(`[DB:saveFBMessage] contacts update error: ${err.message}`);
            }
        }

        // Extract and save links from FB text messages
        if (msg.type === 'text' && msg.body) {
            try {
                const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
                const matches = msg.body.match(urlRegex);
                if (matches) {
                    for (const url of matches) {
                        try {
                            const domain = new URL(url).hostname;
                            this.saveLink(ownerZaloId, msg.thread_id, msg.id + '_' + url.slice(0, 20), url, url, domain, '', msg.timestamp);
                        } catch {}
                    }
                }
            } catch {}
        }
        return isNewMessage || insertedUnified > 0 ? 'new' : repaired ? 'repaired' : 'duplicate';
    }

    public getFBMessages(accountId: string, threadId: string, limit: number = 50, offset: number = 0): any[] {
        return this.query<any>(
            `SELECT * FROM fb_messages
             WHERE account_id = ? AND thread_id = ?
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`,
            [accountId, threadId, limit, offset]
        );
    }

    public updateFBMessageUnsent(id: string): void {
        // Read current body from fb_messages to preserve as recalled_content
        const existing = this.queryOne<any>(
            `SELECT body FROM fb_messages WHERE id = ?`, [id]
        );
        this.run(`UPDATE fb_messages SET is_unsent = 1, body = null WHERE id = ?`, [id]);
        const originalContent = existing?.body || null;
        // Thu hồi báo lần 2 (MQTT và bridge cùng báo): body đã bị xoá ở lần 1 → giữ nội dung gốc đã lưu, không ghi đè rỗng
        this.run(
            `UPDATE messages SET is_recalled = 1, content = '', recalled_content = COALESCE(recalled_content, ?) WHERE msg_id = ? AND channel = 'facebook'`,
            [originalContent, id]
        );
    }

    public updateFBMessageReaction(id: string, reactions: string): void {
        this.run(`UPDATE fb_messages SET reactions = ? WHERE id = ?`, [reactions, id]);
        this.run(`UPDATE messages SET reactions = ? WHERE msg_id = ? AND channel = 'facebook'`, [reactions, id]);
    }

    public updateFBMessageEdit(id: string, newBody: string, editCount: number, timestampMs: number): void {
        // Read current body + edit_history + account + thread from fb_messages
        // Also resolve owner_zalo_id (facebook_id) for contacts update
        const existing = this.queryOne<any>(
            `SELECT fm.body, fm.edit_history, fm.account_id, fm.thread_id,
                    COALESCE(fa.facebook_id, fm.account_id) as owner_zalo_id
             FROM fb_messages fm
             LEFT JOIN fb_accounts fa ON fa.id = fm.account_id
             WHERE fm.id = ?`, [id]
        );
        if (!existing) return; // message not found

        // Build edit history entry from current body
        let historyArr: Array<{ oldBody: string | null; editedAt: number; editCount: number }> = [];
        if (existing.edit_history) {
            try { historyArr = JSON.parse(existing.edit_history); } catch { historyArr = []; }
        }
        historyArr.push({
            oldBody: existing.body,
            editedAt: timestampMs,
            editCount: editCount,
        });

        // Update fb_messages + unified messages
        this.run(
            `UPDATE fb_messages SET body = ?, edit_history = ? WHERE id = ?`,
            [newBody, JSON.stringify(historyArr), id]
        );
        this.run(
            `UPDATE messages SET content = ?, edit_history = ?, is_edited = 1 WHERE msg_id = ? AND channel = 'facebook'`,
            [newBody, JSON.stringify(historyArr), id]
        );

        // Update contact last_message if this message IS the last message in the thread
        if (existing.account_id && existing.thread_id && existing.owner_zalo_id) {
            const isLatest = this.queryOne<any>(
                `SELECT 1 FROM fb_messages
                 WHERE account_id = ? AND thread_id = ? AND id = ?
                 AND timestamp = (SELECT MAX(timestamp) FROM fb_messages WHERE account_id = ? AND thread_id = ? AND is_unsent = 0)`,
                [existing.account_id, existing.thread_id, id, existing.account_id, existing.thread_id]
            );
            if (isLatest) {
                this.run(
                    `UPDATE contacts SET last_message = ?, last_message_time = ?
                     WHERE owner_zalo_id = ? AND contact_id = ? AND channel = 'facebook'`,
                    [newBody?.slice(0, 100) || '[Đã chỉnh sửa]', timestampMs, existing.owner_zalo_id, existing.thread_id]
                );
            }
        }
    }

    public hasFBMessage(accountId: string, messageId: string): boolean {
        const row = this.queryOne<any>(
            `SELECT id FROM fb_messages WHERE id = ? AND account_id = ?`,
            [messageId, accountId]
        );
        return !!row;
    }

    // ── FB CRM Contacts ──

    public saveFBCRMContact(contact: {
        id: string; fb_account_id: string; facebook_user_id: string;
        facebook_thread_id?: string; display_name: string; avatar_url?: string;
    }): void {
        const now = Date.now();
        this.run(`
            INSERT INTO fb_crm_contacts (id, fb_account_id, facebook_user_id, facebook_thread_id,
                display_name, avatar_url, tag_ids, notes, custom_fields, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '{}', ?, ?)
            ON CONFLICT(fb_account_id, facebook_user_id) DO UPDATE SET
              display_name = excluded.display_name, avatar_url = excluded.avatar_url,
              facebook_thread_id = excluded.facebook_thread_id, updated_at = excluded.updated_at
        `, [contact.id, contact.fb_account_id, contact.facebook_user_id,
            contact.facebook_thread_id || null, contact.display_name,
            contact.avatar_url || '', now, now]);
    }

    public getFBCRMContacts(fbAccountId: string): any[] {
        return this.query<any>(
            `SELECT * FROM fb_crm_contacts WHERE fb_account_id = ? ORDER BY display_name ASC`,
            [fbAccountId]
        );
    }

    /**
     * Migration: media library tables
     */
    public migrateMediaLibrary(): void {
        try {
            // Import LibraryService dynamically to avoid circular dependency
            const LibraryService = require('../library/LibraryService').default;
            LibraryService.getInstance().migrate();
        } catch (err: any) {
            Logger.warn(`[DatabaseService] Media library migration skipped: ${err.message}`);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // FTS5 Migration — Full-text search cho messages
    // ═════════════════════════════════════════════════════════════════════

    /**
     * Create FTS5 virtual table for messages + triggers for auto-sync.
     * Nếu SQLite build không hỗ trợ FTS5, bỏ qua một cách an toàn.
     */
    public migrateFTS5(): void {
        try {
            // Check if FTS5 is available
            const ftsCheck = this.query<any>(`SELECT * FROM pragma_compile_options WHERE compile_options LIKE '%ENABLE_FTS5%'`);
            const ftsSupported = ftsCheck.length > 0;

            if (!ftsSupported) {
                // Try creating anyway - better-sqlite3 usually bundles FTS5
                try {
                    this.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                        content,
                        msg_id UNINDEXED,
                        owner_zalo_id UNINDEXED,
                        thread_id UNINDEXED,
                        tokenize='unicode61'
                    )`);
                } catch {
                    Logger.warn('[DatabaseService] FTS5 not supported by this SQLite build - search will use LIKE');
                    return;
                }
            }

            // Check if already exists
            const existing = this.query<any>(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'`);
            if (existing.length > 0) {
                Logger.log('[DatabaseService] FTS5 table already exists, skipping creation');
                return;
            }

            // Create FTS5 table
            this.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content,
                msg_id UNINDEXED,
                owner_zalo_id UNINDEXED,
                thread_id UNINDEXED,
                tokenize='unicode61'
            )`);

            // Create triggers for auto-sync
            this.exec(`
                CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, content, msg_id, owner_zalo_id, thread_id)
                    VALUES (new.rowid, new.content, new.msg_id, new.owner_zalo_id, new.thread_id);
                END
            `);

            this.exec(`
                CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
                    DELETE FROM messages_fts WHERE rowid = old.rowid;
                END
            `);

            this.exec(`
                CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
                    DELETE FROM messages_fts WHERE rowid = old.rowid;
                    INSERT INTO messages_fts(rowid, content, msg_id, owner_zalo_id, thread_id)
                    VALUES (new.rowid, new.content, new.msg_id, new.owner_zalo_id, new.thread_id);
                END
            `);

            // Backfill existing data
            Logger.log('[DatabaseService] FTS5: backfilling existing messages...');
            const count = this.queryOne<any>(`SELECT COUNT(*) as n FROM messages`);
            this.exec(`
                INSERT INTO messages_fts(rowid, content, msg_id, owner_zalo_id, thread_id)
                SELECT rowid, content, msg_id, owner_zalo_id, thread_id FROM messages
                WHERE rowid NOT IN (SELECT rowid FROM messages_fts)
            `);
            this.forceFlush();
            Logger.log(`[DatabaseService] ✅ FTS5 migration complete (${count?.n || 0} messages indexed)`);
        } catch (err: any) {
            Logger.warn(`[DatabaseService] FTS5 migration skipped: ${err.message}. Search will use LIKE fallback.`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // AI CONVERSATIONS — Chat history persistence per thread + assistant
    // ═══════════════════════════════════════════════════════════════════════

    /** Tạo hoặc lấy conversation gần nhất cho (zaloId, threadId, assistantId) */
    public getOrCreateAIConversation(zaloId: string, threadId: string, assistantId: string): any {
        if (!this.initialized) return null;
        try {
            // Tìm conversation gần nhất
            const existing = this.queryOne<any>(
                `SELECT * FROM ai_conversations WHERE zalo_id = ? AND thread_id = ? AND assistant_id = ? ORDER BY last_message_at DESC LIMIT 1`,
                [zaloId, threadId, assistantId]
            );
            if (existing) return existing;

            // Tạo mới
            const id = `aiconv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const now = Date.now();
            this.run(
                `INSERT INTO ai_conversations (id, zalo_id, thread_id, assistant_id, title, last_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
                [id, zaloId, threadId, assistantId, now, now, now]
            );
            return this.queryOne<any>(`SELECT * FROM ai_conversations WHERE id = ?`, [id]);
        } catch (err: any) {
            Logger.error(`[DB] getOrCreateAIConversation: ${err.message}`);
            return null;
        }
    }

    /** Lấy tất cả messages của 1 conversation */
    public getAIConversationMessages(conversationId: string): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT * FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
                [conversationId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getAIConversationMessages: ${err.message}`);
            return [];
        }
    }

    /** Thêm message vào conversation */
    public addAIConversationMessage(conversationId: string, role: string, content: string, segmentsJson?: string): void {
        if (!this.initialized) return;
        try {
            const now = Date.now();
            this.run(
                `INSERT INTO ai_conversation_messages (conversation_id, role, content, segments_json, created_at) VALUES (?, ?, ?, ?, ?)`,
                [conversationId, role, content, segmentsJson || null, now]
            );
            // Cập nhật last_message_at và title nếu là tin nhắn đầu
            this.run(
                `UPDATE ai_conversations SET last_message_at = ?, updated_at = ? WHERE id = ?`,
                [now, now, conversationId]
            );
            // Auto-set title từ tin nhắn user đầu tiên
            if (role === 'user') {
                const msgCount = this.queryOne<any>(`SELECT COUNT(*) as cnt FROM ai_conversation_messages WHERE conversation_id = ?`, [conversationId]);
                if (msgCount?.cnt === 1) {
                    const title = content.slice(0, 80) + (content.length > 80 ? '...' : '');
                    this.run(`UPDATE ai_conversations SET title = ? WHERE id = ? AND title = ''`, [title, conversationId]);
                }
            }
        } catch (err: any) {
            Logger.error(`[DB] addAIConversationMessage: ${err.message}`);
        }
    }

    /** Lấy danh sách conversations của 1 thread */
    public getAIConversations(zaloId: string, threadId: string): any[] {
        if (!this.initialized) return [];
        try {
            return this.query<any>(
                `SELECT * FROM ai_conversations WHERE zalo_id = ? AND thread_id = ? ORDER BY last_message_at DESC`,
                [zaloId, threadId]
            );
        } catch (err: any) {
            Logger.error(`[DB] getAIConversations: ${err.message}`);
            return [];
        }
    }

    /** Xóa conversation + messages */
    public deleteAIConversation(conversationId: string): void {
        if (!this.initialized) return;
        try {
            this.run(`DELETE FROM ai_conversation_messages WHERE conversation_id = ?`, [conversationId]);
            this.run(`DELETE FROM ai_conversations WHERE id = ?`, [conversationId]);
        } catch (err: any) {
            Logger.error(`[DB] deleteAIConversation: ${err.message}`);
        }
    }

    /** Xóa tất cả conversations của 1 thread */
    public deleteAIConversationsForThread(zaloId: string, threadId: string): void {
        if (!this.initialized) return;
        try {
            const convs = this.query<any>(`SELECT id FROM ai_conversations WHERE zalo_id = ? AND thread_id = ?`, [zaloId, threadId]);
            for (const c of convs) {
                this.run(`DELETE FROM ai_conversation_messages WHERE conversation_id = ?`, [c.id]);
            }
            this.run(`DELETE FROM ai_conversations WHERE zalo_id = ? AND thread_id = ?`, [zaloId, threadId]);
        } catch (err: any) {
            Logger.error(`[DB] deleteAIConversationsForThread: ${err.message}`);
        }
    }
}

export default DatabaseService;
