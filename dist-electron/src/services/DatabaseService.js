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
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const electron_1 = require("electron");
const Logger_1 = __importDefault(require("../utils/Logger"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
// better-sqlite3: native SQLite — no WASM heap, memory-mapped I/O
let db = null;
// ── Cached secondary DB for withDbPath (avoids repeated open/close) ─────────
let _cachedSecondaryDb = null;
let _cachedSecondaryPath = null;
let _cachedSecondaryTimer = null;
const SECONDARY_DB_TTL_MS = 30000; // auto-close after 30s idle
function getCachedSecondaryDb(targetDbPath) {
    if (_cachedSecondaryPath === targetDbPath && _cachedSecondaryDb) {
        // Reset idle timer
        if (_cachedSecondaryTimer)
            clearTimeout(_cachedSecondaryTimer);
        _cachedSecondaryTimer = setTimeout(closeCachedSecondaryDb, SECONDARY_DB_TTL_MS);
        return _cachedSecondaryDb;
    }
    // Close previous if different path
    closeCachedSecondaryDb();
    _cachedSecondaryDb = new better_sqlite3_1.default(targetDbPath);
    _cachedSecondaryDb.pragma('journal_mode = WAL');
    _cachedSecondaryPath = targetDbPath;
    _cachedSecondaryTimer = setTimeout(closeCachedSecondaryDb, SECONDARY_DB_TTL_MS);
    return _cachedSecondaryDb;
}
function closeCachedSecondaryDb() {
    if (_cachedSecondaryTimer) {
        clearTimeout(_cachedSecondaryTimer);
        _cachedSecondaryTimer = null;
    }
    if (_cachedSecondaryDb) {
        try {
            _cachedSecondaryDb.close();
        }
        catch { }
        _cachedSecondaryDb = null;
        _cachedSecondaryPath = null;
    }
}
class DatabaseService {
    constructor() {
        this.dbPath = '';
        this.initialized = false;
        /**
         * Switch DB to a different workspace's database file.
         * Closes current DB, opens the new one, runs migrations.
         * Used when user switches workspace in multi-workspace mode.
         */
        /** Lock to prevent concurrent DB access during workspace switch */
        this.switching = false;
        this.switchQueue = [];
    }
    /** Open a better-sqlite3 database at the given path with WAL mode */
    openDb(dbPath) {
        const newDb = new better_sqlite3_1.default(dbPath);
        newDb.pragma('journal_mode = WAL');
        newDb.pragma('synchronous = NORMAL');
        return newDb;
    }
    static getInstance() {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }
    async initialize() {
        try {
            const userDataPath = electron_1.app.getPath('userData');
            Logger_1.default.log(`[DatabaseService] userData path: ${userDataPath}`);
            // ─── Workspace-aware DB path resolution ─────────────────────
            let resolvedViaWorkspace = false;
            try {
                const WorkspaceManager = require('../utils/WorkspaceManager').default;
                const wm = WorkspaceManager.getInstance();
                const activeDbPath = wm.getActiveDbPath();
                if (activeDbPath) {
                    this.dbPath = activeDbPath;
                    resolvedViaWorkspace = true;
                    Logger_1.default.log(`[DatabaseService] DB path from WorkspaceManager: ${this.dbPath}`);
                }
            }
            catch { /* WorkspaceManager not yet initialized — fall back to legacy */ }
            if (!resolvedViaWorkspace) {
                let dbFolder = userDataPath;
                const configPath = path.join(userDataPath, 'deplao-config.json');
                if (fs.existsSync(configPath)) {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        if (cfg.dbFolder) {
                            if (fs.existsSync(cfg.dbFolder)) {
                                dbFolder = cfg.dbFolder;
                                Logger_1.default.log(`[DatabaseService] Using custom dbFolder from config: ${dbFolder}`);
                            }
                            else {
                                Logger_1.default.warn(`[DatabaseService] Configured dbFolder not found: ${cfg.dbFolder} — attempting to create it`);
                                try {
                                    fs.mkdirSync(cfg.dbFolder, { recursive: true });
                                    dbFolder = cfg.dbFolder;
                                    Logger_1.default.log(`[DatabaseService] Created missing dbFolder: ${dbFolder}`);
                                }
                                catch (mkErr) {
                                    Logger_1.default.error(`[DatabaseService] Cannot create dbFolder ${cfg.dbFolder}: ${mkErr.message} — falling back to userData`);
                                }
                            }
                        }
                    }
                    catch { }
                }
                this.dbPath = path.join(dbFolder, 'deplao-tool.db');
            }
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            // Open DB with better-sqlite3 (native SQLite, memory-mapped I/O)
            db = this.openDb(this.dbPath);
            this.createTables();
            this.migrate();
            this.initErpSchema();
            this.initialized = true;
            Logger_1.default.log(`[DatabaseService] Initialized at ${this.dbPath} (better-sqlite3, WAL mode)`);
        }
        catch (error) {
            Logger_1.default.error(`[DatabaseService] Failed to initialize: ${error.message}`);
            // Fall back to in-memory db so app still runs
            try {
                db = new better_sqlite3_1.default(':memory:');
                this.createTables();
                this.migrate();
                this.initErpSchema();
                this.initialized = true;
                Logger_1.default.warn(`[DatabaseService] Using in-memory database as fallback`);
            }
            catch (e2) {
                Logger_1.default.error(`[DatabaseService] In-memory fallback also failed: ${e2.message}`);
            }
        }
    }
    /** No-op: better-sqlite3 with WAL mode writes directly to disk. Kept for API compat. */
    save() {
        // better-sqlite3 writes to disk automatically via WAL — nothing to do
    }
    /** No-op: better-sqlite3 auto-persists. Kept for API compat. */
    scheduleSave() {
        // No-op — WAL mode auto-writes
    }
    /**
     * WAL checkpoint — ensures all writes are flushed to main DB file.
     * Call before copy/move DB file, switch workspace, or app quit.
     */
    forceFlush() {
        try {
            if (db) {
                db.pragma('wal_checkpoint(TRUNCATE)');
                Logger_1.default.log(`[DatabaseService] WAL checkpoint completed for ${this.dbPath}`);
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] WAL checkpoint error: ${err.message}`);
        }
    }
    /**
     * Reinitialize DatabaseService từ path mới (đọc lại deplao-config.json).
     * Gọi sau khi thay đổi dbFolder trong config để áp dụng ngay không cần restart.
     */
    async reinitialize() {
        Logger_1.default.log('[DatabaseService] Reinitializing from new config...');
        try {
            db?.close();
        }
        catch { }
        db = null;
        this.initialized = false;
        this.dbPath = '';
        await this.initialize();
        Logger_1.default.log(`[DatabaseService] Reinitialized at ${this.dbPath}`);
    }
    async switchToWorkspaceDb(newDbPath) {
        Logger_1.default.log(`[DatabaseService] Switching DB to: ${newDbPath}`);
        const targetDbPath = path.resolve(newDbPath);
        const currentDbPath = this.dbPath ? path.resolve(this.dbPath) : '';
        if (currentDbPath && currentDbPath === targetDbPath) {
            Logger_1.default.log(`[DatabaseService] Switch skipped — already using ${targetDbPath}`);
            return;
        }
        // Set switching lock — queues any concurrent run()/query() calls
        this.switching = true;
        const prevDbPath = this.dbPath;
        const prevDb = db;
        try {
            const dir = path.dirname(targetDbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                Logger_1.default.log(`[DatabaseService] Created directory: ${dir}`);
            }
            // Close cached secondary DB (if any) before switching
            closeCachedSecondaryDb();
            // Close old DB
            try {
                prevDb?.close();
            }
            catch (closeErr) {
                Logger_1.default.warn(`[DatabaseService] Failed to close previous DB before switch: ${closeErr.message}`);
            }
            db = null;
            // Open the new DB (better-sqlite3 handles create-if-not-exists automatically)
            try {
                db = this.openDb(targetDbPath);
                Logger_1.default.log(`[DatabaseService] Opened DB: ${targetDbPath}`);
            }
            catch (loadErr) {
                const msg = loadErr?.message || String(loadErr);
                Logger_1.default.warn(`[DatabaseService] Failed to open DB (corrupt?): ${msg}. Backing up and creating fresh DB.`);
                try {
                    const backupPath = `${targetDbPath}.corrupt-${Date.now()}.bak`;
                    fs.copyFileSync(targetDbPath, backupPath);
                    Logger_1.default.warn(`[DatabaseService] Backed up corrupt DB to: ${backupPath}`);
                }
                catch (backupErr) {
                    Logger_1.default.warn(`[DatabaseService] Failed to back up corrupt DB: ${backupErr.message}`);
                }
                // Delete corrupt file and retry
                try {
                    fs.unlinkSync(targetDbPath);
                }
                catch { }
                db = this.openDb(targetDbPath);
                Logger_1.default.log(`[DatabaseService] Created fresh DB after failed load: ${targetDbPath}`);
            }
            this.dbPath = targetDbPath;
            this.createTables();
            this.migrate();
            this.initErpSchema();
            this.initialized = true;
            Logger_1.default.log(`[DatabaseService] Workspace DB ready at ${this.dbPath}`);
        }
        catch (err) {
            const errMsg = err?.message || String(err);
            Logger_1.default.error(`[DatabaseService] switchToWorkspaceDb failed: ${errMsg}. Rolling back to ${prevDbPath}.`);
            this.dbPath = prevDbPath;
            try {
                if (prevDbPath && fs.existsSync(prevDbPath)) {
                    db = this.openDb(prevDbPath);
                }
                else {
                    db = new better_sqlite3_1.default(':memory:');
                }
                this.initialized = true;
                Logger_1.default.warn(`[DatabaseService] Restored previous DB: ${prevDbPath}`);
            }
            catch (restoreErr) {
                Logger_1.default.error(`[DatabaseService] Failed to restore previous DB: ${restoreErr.message}`);
            }
            throw new Error(`switchToWorkspaceDb failed: ${errMsg}`);
        }
        finally {
            this.switching = false;
            const queued = this.switchQueue.splice(0);
            for (const item of queued) {
                try {
                    item.resolve(item.fn());
                }
                catch (e) {
                    item.resolve(undefined);
                }
            }
        }
    }
    /**
     * Temporarily switch to a different DB file, run a synchronous callback,
     * then switch back. Used by EmployeeService to access the relay workspace DB.
     * @deprecated Use queryOtherDb() instead — withDbPath swaps the global db and is unsafe with concurrent IPC.
     */
    withDbPath(targetDbPath, fn) {
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
        }
        finally {
            db = currentDb;
            this.dbPath = currentPath;
        }
    }
    /**
     * Execute a callback against a SEPARATE DB instance — does NOT swap the global db.
     * Safe for use from relay/socket handlers that may run concurrently with IPC.
     */
    queryOtherDb(targetDbPath, fn) {
        const resolvedPath = path.resolve(targetDbPath);
        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`DB file not found: ${resolvedPath}`);
        }
        const otherDb = new better_sqlite3_1.default(resolvedPath, { readonly: false });
        otherDb.pragma('journal_mode = WAL');
        try {
            return fn(otherDb);
        }
        finally {
            try {
                otherDb.close();
            }
            catch { }
        }
    }
    exec(sql) {
        db.exec(sql);
    }
    run(sql, params = []) {
        db.prepare(sql).run(...params);
    }
    /** Execute SQL without flushing to disk — same as run() now (WAL auto-writes) */
    runNoSave(sql, params = []) {
        db.prepare(sql).run(...params);
    }
    /** Run an INSERT and return the new rowid. */
    runInsert(sql, params = []) {
        const result = db.prepare(sql).run(...params);
        return Number(result.lastInsertRowid) || 0;
    }
    /**
     * Run `fn` inside a SQLite transaction. Returns whatever `fn` returns.
     * Uses better-sqlite3 native transaction → automatic ROLLBACK on throw.
     */
    transaction(fn) {
        return db.transaction(fn)();
    }
    query(sql, params = []) {
        try {
            return db.prepare(sql).all(...params);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] Query error: ${err.message} | SQL: ${sql}`);
            return [];
        }
    }
    queryOne(sql, params = []) {
        try {
            return db.prepare(sql).get(...params);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] QueryOne error: ${err.message} | SQL: ${sql}`);
            return undefined;
        }
    }
    /** Chuẩn hóa số điện thoại VN trước khi lưu DB: +84/84 -> 0 */
    normalizeVietnamPhone(phone) {
        if (!phone)
            return '';
        const cleaned = String(phone).trim().replace(/[\s().-]/g, '');
        if (!cleaned)
            return '';
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
    normalizeWorkflowChannel(channel) {
        return channel === 'facebook' ? 'facebook' : 'zalo';
    }
    createTables() {
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
                UNIQUE(msg_id, owner_zalo_id)
            );
            CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(owner_zalo_id, thread_id, timestamp);
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
        // Sticker cache — device-wide (no owner_zalo_id)
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
        try {
            this.exec(`ALTER TABLE crm_campaigns ADD COLUMN friend_request_message TEXT NOT NULL DEFAULT ''`);
        }
        catch { }
        try {
            this.exec(`ALTER TABLE crm_campaigns ADD COLUMN campaign_type TEXT NOT NULL DEFAULT 'message'`);
        }
        catch { }
        try {
            this.exec(`ALTER TABLE crm_campaigns ADD COLUMN mixed_config TEXT NOT NULL DEFAULT '{}'`);
        }
        catch { }
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
        this.exec(`
            CREATE TABLE IF NOT EXISTS crm_send_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_zalo_id TEXT NOT NULL,
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
            const wfCols = this.query(`PRAGMA table_info(workflows)`);
            if (!wfCols.some((c) => c.name === 'page_ids')) {
                db.exec(`ALTER TABLE workflows ADD COLUMN page_ids TEXT DEFAULT ''`);
                // Backfill: migrate existing page_id → page_ids
                db.exec(`UPDATE workflows SET page_ids = page_id WHERE page_id != '' AND (page_ids IS NULL OR page_ids = '')`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added page_ids column to workflows');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] workflows page_ids migration: ${err.message}`);
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
                model                 TEXT NOT NULL DEFAULT 'gpt-5.4-mini',
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
    }
    // ─── ERP Schema ────────────────────────────────────────────────────────────
    /**
     * Khởi tạo schema cho ERP module. Idempotent — safe to call on every startup.
     * Tất cả bảng đều prefix erp_.
     */
    initErpSchema() {
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
            Logger_1.default.log('[DatabaseService] ERP schema initialized');
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] initErpSchema error: ${err.message}`);
        }
    }
    /** Dọn dẹp dữ liệu cũ bị lỗi từ các phiên bản trước */
    migrate() {
        try {
            // Add quote_data column if it doesn't exist
            const cols = this.query(`PRAGMA table_info(messages)`);
            const hasQuoteData = cols.some((c) => c.name === 'quote_data');
            if (!hasQuoteData) {
                db.exec(`ALTER TABLE messages ADD COLUMN quote_data TEXT DEFAULT NULL`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added quote_data column');
            }
            const hasReactions = cols.some((c) => c.name === 'reactions');
            if (!hasReactions) {
                db.exec(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added reactions column');
            }
            const hasIsRecalled = cols.some((c) => c.name === 'is_recalled');
            if (!hasIsRecalled) {
                db.exec(`ALTER TABLE messages ADD COLUMN is_recalled INTEGER DEFAULT 0`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added is_recalled column');
            }
            const hasRecalledContent = cols.some((c) => c.name === 'recalled_content');
            if (!hasRecalledContent) {
                db.exec(`ALTER TABLE messages ADD COLUMN recalled_content TEXT DEFAULT NULL`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added recalled_content column');
            }
            const hasDeletedBy = cols.some((c) => c.name === 'deleted_by');
            if (!hasDeletedBy) {
                db.exec(`ALTER TABLE messages ADD COLUMN deleted_by TEXT DEFAULT NULL`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added deleted_by column');
            }
            // Add listener_active column to accounts if missing
            const accCols = this.query(`PRAGMA table_info(accounts)`);
            const hasListenerActive = accCols.some((c) => c.name === 'listener_active');
            if (!hasListenerActive) {
                db.exec(`ALTER TABLE accounts ADD COLUMN listener_active INTEGER DEFAULT 1`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added listener_active column');
            }
            // Đếm trước để log
            const badContacts = this.query(`SELECT count(*) as n FROM contacts WHERE contact_id = 'undefined' OR contact_id = '' OR contact_id IS NULL`);
            const badMessages = this.query(`SELECT count(*) as n FROM messages WHERE thread_id = 'undefined' OR thread_id = '' OR thread_id IS NULL`);
            const nContacts = badContacts[0]?.n || 0;
            const nMessages = badMessages[0]?.n || 0;
            if (nContacts > 0 || nMessages > 0) {
                Logger_1.default.warn(`[DatabaseService] 🧹 Migration: found ${nContacts} bad contacts, ${nMessages} bad messages — deleting...`);
                db.exec(`DELETE FROM contacts WHERE contact_id = 'undefined' OR contact_id = '' OR contact_id IS NULL`);
                db.exec(`DELETE FROM messages WHERE thread_id = 'undefined' OR thread_id = '' OR thread_id IS NULL`);
                this.save();
                Logger_1.default.log(`[DatabaseService] ✅ Migration: deleted ${nContacts} bad contacts, ${nMessages} bad messages`);
            }
            else {
                Logger_1.default.log('[DatabaseService] ✅ Migration: no bad data found');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] Migration warning: ${err.message}`);
        }
        // ─── Migration: add `channel` column for multi-channel support ────────────
        try {
            const contactCols = this.query(`PRAGMA table_info(contacts)`);
            const hasChannel = contactCols.some((c) => c.name === 'channel');
            if (!hasChannel) {
                db.exec(`ALTER TABLE contacts ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db.exec(`ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db.exec(`ALTER TABLE accounts ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                this.save();
                Logger_1.default.log('[DatabaseService] ✅ Migration: added channel column to contacts, messages, accounts');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] Migration channel column: ${err.message}`);
        }
        // ─── Migration: copy fb_* data → unified tables (Phase B3) ─────────────
        try {
            const hasFbTable = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='fb_accounts'`);
            if (hasFbTable.length > 0) {
                const fbInAccounts = this.query(`SELECT COUNT(*) as n FROM accounts WHERE channel = 'facebook'`);
                if ((fbInAccounts[0]?.n || 0) === 0) {
                    const fbAccCount = this.query(`SELECT COUNT(*) as n FROM fb_accounts`);
                    if ((fbAccCount[0]?.n || 0) > 0) {
                        Logger_1.default.log('[DatabaseService] 🔄 Migration B3: copying fb_* data → unified tables...');
                        db.exec(`
                            INSERT OR IGNORE INTO accounts (zalo_id, full_name, avatar_url, imei, user_agent, cookies, is_active, created_at, channel)
                            SELECT COALESCE(facebook_id, id), COALESCE(name, ''), COALESCE(avatar_url, ''), '', '', COALESCE(cookie_encrypted, ''), 1, datetime(created_at/1000, 'unixepoch'), 'facebook'
                            FROM fb_accounts
                        `);
                        db.exec(`
                            INSERT OR IGNORE INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
                            SELECT COALESCE(f.facebook_id, ft.account_id), ft.id, COALESCE(ft.name, ''), '', 0,
                                   CASE WHEN ft.type = 'user' THEN 'user' ELSE 'group' END,
                                   COALESCE(ft.unread_count, 0), COALESCE(ft.last_message_preview, ''), COALESCE(ft.last_message_at, 0), 'facebook'
                            FROM fb_threads ft
                            LEFT JOIN fb_accounts f ON f.id = ft.account_id
                        `);
                        db.exec(`
                            INSERT OR IGNORE INTO messages (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel)
                            SELECT fm.id, COALESCE(f.facebook_id, fm.account_id), fm.thread_id, 0, COALESCE(fm.sender_id, ''),
                                   COALESCE(fm.body, ''), COALESCE(fm.type, 'text'), fm.timestamp, COALESCE(fm.is_self, 0),
                                   COALESCE(fm.attachments, '[]'), 'received', 'facebook'
                            FROM fb_messages fm
                            LEFT JOIN fb_accounts f ON f.id = fm.account_id
                        `);
                        this.save();
                        Logger_1.default.log('[DatabaseService] ✅ Migration B3: fb_* data copied to unified tables');
                    }
                }
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] Migration fb→unified: ${err.message}`);
        }
        // ─── Migration: channel indexes ────────────────────────────────────────
        try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_channel ON contacts(channel, owner_zalo_id)`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, owner_zalo_id, thread_id)`);
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] Migration channel indexes: ${err.message}`);
        }
        // ─── Migration: add channel to workflows + backfill legacy rows ───────
        try {
            const workflowCols = this.query(`PRAGMA table_info(workflows)`);
            if (workflowCols.length > 0 && !workflowCols.some((c) => c.name === 'channel')) {
                db.exec(`ALTER TABLE workflows ADD COLUMN channel TEXT NOT NULL DEFAULT 'zalo'`);
                Logger_1.default.log('[DatabaseService] Migration: added channel column to workflows');
            }
            db.exec(`UPDATE workflows SET channel = 'zalo' WHERE channel IS NULL OR TRIM(channel) = ''`);
            this.save();
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] workflow channel migration warning: ${err.message}`);
        }
        // ─── Migration B4: FB accounts.zalo_id UUID → facebook_id ─────────────
        // Previously FB accounts stored internal UUID as zalo_id; now we use the real Facebook UID
        try {
            const fbWithUuid = this.query(`SELECT a.zalo_id, f.facebook_id FROM accounts a
                 JOIN fb_accounts f ON a.zalo_id = f.id
                 WHERE a.channel = 'facebook' AND f.facebook_id IS NOT NULL AND f.facebook_id != ''`);
            for (const row of fbWithUuid) {
                if (row.zalo_id !== row.facebook_id) {
                    // Check if facebook_id already exists in accounts to avoid unique constraint violation
                    const existing = this.queryOne(`SELECT 1 FROM accounts WHERE zalo_id = ?`, [row.facebook_id]);
                    if (!existing) {
                        db.exec(`UPDATE accounts SET zalo_id = '${row.facebook_id}' WHERE zalo_id = '${row.zalo_id}' AND channel = 'facebook'`);
                        Logger_1.default.log(`[DatabaseService] ✅ Migration B4: FB account ${row.zalo_id} → ${row.facebook_id}`);
                    }
                    else {
                        // Already migrated or duplicate — remove the old UUID row
                        db.exec(`DELETE FROM accounts WHERE zalo_id = '${row.zalo_id}' AND channel = 'facebook'`);
                        Logger_1.default.log(`[DatabaseService] ✅ Migration B4: Removed duplicate FB account row ${row.zalo_id}`);
                    }
                }
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] Migration B4 fb zalo_id→facebook_id: ${err.message}`);
        }
        // ─── Migration: add channel to CRM tables ──────────────────────────────
        // ─── Migration B5: fix contacts & messages owner_zalo_id UUID → facebook_id ──
        // Migration B3 incorrectly used account_id (UUID) as owner_zalo_id.
        // This rewrites them to the real facebook_id so UI queries match.
        try {
            const fbAccs = this.query(`SELECT id, facebook_id FROM fb_accounts WHERE facebook_id IS NOT NULL AND facebook_id != ''`);
            for (const acc of fbAccs) {
                if (acc.id === acc.facebook_id)
                    continue; // already correct
                // Fix contacts
                const contactsFixed = db.prepare(`UPDATE contacts SET owner_zalo_id = ? WHERE owner_zalo_id = ? AND channel = 'facebook'`).run(acc.facebook_id, acc.id);
                // Fix messages
                const messagesFixed = db.prepare(`UPDATE messages SET owner_zalo_id = ? WHERE owner_zalo_id = ? AND channel = 'facebook'`).run(acc.facebook_id, acc.id);
                if ((contactsFixed.changes || 0) > 0 || (messagesFixed.changes || 0) > 0) {
                    Logger_1.default.log(`[DatabaseService] ✅ Migration B5: Rewrote owner_zalo_id ${acc.id} → ${acc.facebook_id} (contacts: ${contactsFixed.changes}, messages: ${messagesFixed.changes})`);
                }
            }
            // Also fix any stale UUIDs from previously deleted accounts
            // Find contacts/messages with UUID owner_zalo_id that match no current fb_accounts
            const staleContacts = this.query(`SELECT DISTINCT c.owner_zalo_id FROM contacts c
                 WHERE c.channel = 'facebook'
                 AND c.owner_zalo_id NOT GLOB '[0-9]*'
                 AND NOT EXISTS (SELECT 1 FROM fb_accounts f WHERE f.id = c.owner_zalo_id)`);
            for (const sc of staleContacts) {
                // Try to find fb_account by matching thread data
                const sample = this.queryOne(`SELECT t.account_id FROM fb_threads t
                     JOIN contacts c ON c.contact_id = t.id
                     WHERE c.owner_zalo_id = ? LIMIT 1`, [sc.owner_zalo_id]);
                if (sample?.account_id) {
                    const fbAcc = this.queryOne(`SELECT facebook_id FROM fb_accounts WHERE id = ?`, [sample.account_id]);
                    if (fbAcc?.facebook_id) {
                        db.prepare(`UPDATE contacts SET owner_zalo_id = ? WHERE owner_zalo_id = ? AND channel = 'facebook'`).run(fbAcc.facebook_id, sc.owner_zalo_id);
                        db.prepare(`UPDATE messages SET owner_zalo_id = ? WHERE owner_zalo_id = ? AND channel = 'facebook'`).run(fbAcc.facebook_id, sc.owner_zalo_id);
                        Logger_1.default.log(`[DatabaseService] ✅ Migration B5: Fixed stale UUID ${sc.owner_zalo_id} → ${fbAcc.facebook_id}`);
                    }
                }
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] Migration B5 fix owner_zalo_id: ${err.message}`);
        }
        try {
            const crmTagCols = this.query(`PRAGMA table_info(crm_tags)`);
            if (crmTagCols.length > 0 && !crmTagCols.some((c) => c.name === 'channel')) {
                db.exec(`ALTER TABLE crm_tags ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db.exec(`ALTER TABLE crm_contact_tags ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                db.exec(`ALTER TABLE crm_notes ADD COLUMN channel TEXT DEFAULT 'zalo'`);
                this.save();
                Logger_1.default.log('[DatabaseService] ✅ Migration: added channel to CRM tables');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] Migration CRM channel: ${err.message}`);
        }
        // Migration: create friends table if missing
        try {
            const tables = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='friends'`);
            if (tables.length === 0) {
                db.exec(`
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
                db.exec(`CREATE INDEX IF NOT EXISTS idx_friends_owner ON friends(owner_zalo_id)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created friends table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] Friends table migration warning: ${err.message}`);
        }
        // Migration: create page_group_member table if missing
        try {
            const gmt = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='page_group_member'`);
            if (gmt.length === 0) {
                db.exec(`
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
                db.exec(`CREATE INDEX IF NOT EXISTS idx_group_member ON page_group_member(owner_zalo_id, group_id)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created page_group_member table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] page_group_member migration warning: ${err.message}`);
        }
        // Migration: create friend_requests table if missing
        try {
            const frt = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='friend_requests'`);
            if (frt.length === 0) {
                db.exec(`
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
                db.exec(`CREATE INDEX IF NOT EXISTS idx_friend_requests_owner ON friend_requests(owner_zalo_id, direction)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created friend_requests table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] friend_requests migration warning: ${err.message}`);
        }
        try {
            const st = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='stickers'`);
            if (st.length === 0) {
                db.exec(`
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
                db.exec(`
                    CREATE TABLE IF NOT EXISTS recent_stickers (
                        sticker_id INTEGER PRIMARY KEY,
                        used_at INTEGER NOT NULL
                    )
                `);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created stickers/recent_stickers tables');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] stickers migration warning: ${err.message}`);
        }
        // Migration: add unsupported column to stickers + sticker_packs table
        try {
            const cols = this.query(`PRAGMA table_info(stickers)`);
            if (cols.length > 0 && !cols.find((c) => c.name === 'unsupported')) {
                db.exec(`ALTER TABLE stickers ADD COLUMN unsupported INTEGER DEFAULT 0`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added unsupported column to stickers');
            }
            const sp = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='sticker_packs'`);
            if (sp.length === 0) {
                db.exec(`
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
                Logger_1.default.log('[DatabaseService] Migration: created sticker_packs table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] sticker_packs migration warning: ${err.message}`);
        }
        // Migration: create keyword_stickers table if missing
        try {
            const ks = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='keyword_stickers'`);
            if (ks.length === 0) {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS keyword_stickers (
                        keyword TEXT PRIMARY KEY,
                        sticker_ids TEXT DEFAULT '[]',
                        updated_at INTEGER DEFAULT 0
                    )
                `);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created keyword_stickers table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] keyword_stickers migration warning: ${err.message}`);
        }
        // Migration: create pinned_messages table if missing
        try {
            const pm = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='pinned_messages'`);
            if (pm.length === 0) {
                db.exec(`
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
                db.exec(`CREATE INDEX IF NOT EXISTS idx_pinned ON pinned_messages(owner_zalo_id, thread_id, pinned_at)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created pinned_messages table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] pinned_messages migration warning: ${err.message}`);
        }
        // Migration: create local_quick_messages table if missing
        try {
            const lqm = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='local_quick_messages'`);
            if (lqm.length === 0) {
                db.exec(`
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
                db.exec(`CREATE INDEX IF NOT EXISTS idx_lqm_owner ON local_quick_messages(owner_zalo_id)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created local_quick_messages table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] local_quick_messages migration warning: ${err.message}`);
        }
        // Migration: add phone column to accounts if missing
        try {
            const cols = this.query(`PRAGMA table_info(accounts)`);
            if (!cols.some((c) => c.name === 'phone')) {
                db.exec(`ALTER TABLE accounts ADD COLUMN phone TEXT DEFAULT ''`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added phone column to accounts');
            }
            if (!cols.some((c) => c.name === 'is_business')) {
                db.exec(`ALTER TABLE accounts ADD COLUMN is_business INTEGER DEFAULT 0`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added is_business column to accounts');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] accounts migration warning: ${err.message}`);
        }
        // Migration: add alias column to contacts if missing
        try {
            const contactCols = this.query(`PRAGMA table_info(contacts)`);
            const names = contactCols.map((c) => c.name);
            let needSave = false;
            if (!names.includes('is_muted')) {
                db.exec(`ALTER TABLE contacts ADD COLUMN is_muted INTEGER DEFAULT 0`);
                Logger_1.default.log('[DatabaseService] Migration: added is_muted to contacts');
                needSave = true;
            }
            if (!names.includes('mute_until')) {
                db.exec(`ALTER TABLE contacts ADD COLUMN mute_until INTEGER DEFAULT 0`);
                Logger_1.default.log('[DatabaseService] Migration: added mute_until to contacts');
                needSave = true;
            }
            if (!names.includes('is_in_others')) {
                db.exec(`ALTER TABLE contacts ADD COLUMN is_in_others INTEGER DEFAULT 0`);
                Logger_1.default.log('[DatabaseService] Migration: added is_in_others to contacts');
                needSave = true;
            }
            if (!names.includes('alias')) {
                db.exec(`ALTER TABLE contacts ADD COLUMN alias TEXT DEFAULT ''`);
                Logger_1.default.log('[DatabaseService] Migration: added alias to contacts');
                needSave = true;
            }
            if (!names.includes('gender')) {
                db.exec(`ALTER TABLE contacts ADD COLUMN gender INTEGER DEFAULT NULL`);
                Logger_1.default.log('[DatabaseService] Migration: added gender to contacts');
                needSave = true;
            }
            if (!names.includes('birthday')) {
                db.exec(`ALTER TABLE contacts ADD COLUMN birthday TEXT DEFAULT NULL`);
                Logger_1.default.log('[DatabaseService] Migration: added birthday to contacts');
                needSave = true;
            }
            if (needSave)
                this.save();
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] contacts flags migration warning: ${err.message}`);
        }
        // Migration: add display_name and phone to crm_send_log if missing
        try {
            const logCols = this.query(`PRAGMA table_info(crm_send_log)`);
            const logColNames = logCols.map((c) => c.name);
            let needSave = false;
            if (!logColNames.includes('display_name')) {
                db.exec(`ALTER TABLE crm_send_log ADD COLUMN display_name TEXT DEFAULT ''`);
                Logger_1.default.log('[DatabaseService] Migration: added display_name to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('phone')) {
                db.exec(`ALTER TABLE crm_send_log ADD COLUMN phone TEXT DEFAULT ''`);
                Logger_1.default.log('[DatabaseService] Migration: added phone to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('contact_type')) {
                db.exec(`ALTER TABLE crm_send_log ADD COLUMN contact_type TEXT DEFAULT 'user'`);
                Logger_1.default.log('[DatabaseService] Migration: added contact_type to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('data_request')) {
                db.exec(`ALTER TABLE crm_send_log ADD COLUMN data_request TEXT DEFAULT ''`);
                Logger_1.default.log('[DatabaseService] Migration: added data_request to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('data_response')) {
                db.exec(`ALTER TABLE crm_send_log ADD COLUMN data_response TEXT DEFAULT ''`);
                Logger_1.default.log('[DatabaseService] Migration: added data_response to crm_send_log');
                needSave = true;
            }
            if (!logColNames.includes('send_type')) {
                db.exec(`ALTER TABLE crm_send_log ADD COLUMN send_type TEXT DEFAULT ''`);
                Logger_1.default.log('[DatabaseService] Migration: added send_type to crm_send_log');
                needSave = true;
            }
            if (needSave)
                this.save();
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] crm_send_log migration warning: ${err.message}`);
        }
        // Migration: add text_color to local_labels if missing
        try {
            const llCols = this.query(`PRAGMA table_info(local_labels)`);
            if (llCols.length > 0 && !llCols.some((c) => c.name === 'text_color')) {
                db.exec(`ALTER TABLE local_labels ADD COLUMN text_color TEXT NOT NULL DEFAULT '#FFFFFF'`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added text_color to local_labels');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] local_labels text_color migration: ${err.message}`);
        }
        // Migration: add is_active + sort_order to local_quick_messages
        try {
            const lqmCols = this.query(`PRAGMA table_info(local_quick_messages)`);
            if (lqmCols.length > 0) {
                const lqmNames = lqmCols.map((c) => c.name);
                if (!lqmNames.includes('is_active')) {
                    db.exec(`ALTER TABLE local_quick_messages ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
                    Logger_1.default.log('[DatabaseService] Migration: added is_active to local_quick_messages');
                }
                if (!lqmNames.includes('sort_order')) {
                    db.exec(`ALTER TABLE local_quick_messages ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
                    Logger_1.default.log('[DatabaseService] Migration: added sort_order to local_quick_messages');
                }
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] local_quick_messages is_active/sort_order migration: ${err.message}`);
        }
        // Migration: add is_active + sort_order + shortcut to local_labels
        try {
            const llCols2 = this.query(`PRAGMA table_info(local_labels)`);
            if (llCols2.length > 0) {
                const llNames2 = llCols2.map((c) => c.name);
                if (!llNames2.includes('is_active')) {
                    db.exec(`ALTER TABLE local_labels ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
                    Logger_1.default.log('[DatabaseService] Migration: added is_active to local_labels');
                }
                if (!llNames2.includes('sort_order')) {
                    db.exec(`ALTER TABLE local_labels ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
                    Logger_1.default.log('[DatabaseService] Migration: added sort_order to local_labels');
                }
                if (!llNames2.includes('shortcut')) {
                    db.exec(`ALTER TABLE local_labels ADD COLUMN shortcut TEXT NOT NULL DEFAULT ''`);
                    Logger_1.default.log('[DatabaseService] Migration: added shortcut to local_labels');
                }
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] local_labels is_active/sort_order/shortcut migration: ${err.message}`);
        }
        // Migration: add context_message_count to ai_assistants if missing
        try {
            const aiCols = this.query(`PRAGMA table_info(ai_assistants)`);
            if (aiCols.length > 0 && !aiCols.some((c) => c.name === 'context_message_count')) {
                db.exec(`ALTER TABLE ai_assistants ADD COLUMN context_message_count INTEGER NOT NULL DEFAULT 30`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added context_message_count to ai_assistants');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] ai_assistants context_message_count migration: ${err.message}`);
        }
        // Migration: add pinned_products_json to ai_assistants if missing
        try {
            const aiCols2 = this.query(`PRAGMA table_info(ai_assistants)`);
            if (aiCols2.length > 0 && !aiCols2.some((c) => c.name === 'pinned_products_json')) {
                db.exec(`ALTER TABLE ai_assistants ADD COLUMN pinned_products_json TEXT NOT NULL DEFAULT '[]'`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added pinned_products_json to ai_assistants');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] pinned_products_json migration: ${err.message}`);
        }
        // Migration: create ai_account_assistants table for per-account assistant assignment
        try {
            const aat = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='ai_account_assistants'`);
            if (aat.length === 0) {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS ai_account_assistants (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        zalo_id TEXT NOT NULL,
                        role TEXT NOT NULL CHECK(role IN ('suggestion', 'panel')),
                        assistant_id TEXT NOT NULL,
                        UNIQUE(zalo_id, role),
                        FOREIGN KEY(assistant_id) REFERENCES ai_assistants(id) ON DELETE CASCADE
                    )
                `);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_account_role ON ai_account_assistants(zalo_id, role)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created ai_account_assistants table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] ai_account_assistants migration: ${err.message}`);
        }
        // Migration: create ai_usage_logs table for tracking AI usage
        try {
            const aul = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='ai_usage_logs'`);
            if (aul.length === 0) {
                db.exec(`
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
                db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage_logs(created_at)`);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_assistant ON ai_usage_logs(assistant_id, created_at)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created ai_usage_logs table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] ai_usage_logs migration: ${err.message}`);
        }
        // Migration: create message_drafts table if missing
        try {
            const md = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='message_drafts'`);
            if (md.length === 0) {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS message_drafts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        content TEXT NOT NULL DEFAULT '',
                        updated_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, thread_id)
                    )
                `);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_drafts_owner ON message_drafts(owner_zalo_id)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created message_drafts table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] message_drafts migration: ${err.message}`);
        }
        // Migration: create bank_cards table if missing
        try {
            const bc = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='bank_cards'`);
            if (bc.length === 0) {
                db.exec(`
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
                db.exec(`CREATE INDEX IF NOT EXISTS idx_bank_cards_owner ON bank_cards(owner_zalo_id)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created bank_cards table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] bank_cards migration: ${err.message}`);
        }
        // Migration: create local_pinned_conversations table if missing
        try {
            const lpc = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='local_pinned_conversations'`);
            if (lpc.length === 0) {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS local_pinned_conversations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        owner_zalo_id TEXT NOT NULL,
                        thread_id TEXT NOT NULL,
                        pinned_at INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(owner_zalo_id, thread_id)
                    )
                `);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_lpc_owner ON local_pinned_conversations(owner_zalo_id, pinned_at DESC)`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: created local_pinned_conversations table');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] local_pinned_conversations migration: ${err.message}`);
        }
        // Migration: add topic_id and contact_type to crm_notes if missing
        try {
            const noteCols = this.query(`PRAGMA table_info(crm_notes)`);
            if (noteCols.length > 0) {
                const noteColNames = noteCols.map((c) => c.name);
                let needSave = false;
                if (!noteColNames.includes('topic_id')) {
                    db.exec(`ALTER TABLE crm_notes ADD COLUMN topic_id TEXT DEFAULT NULL`);
                    Logger_1.default.log('[DatabaseService] Migration: added topic_id to crm_notes');
                    needSave = true;
                }
                if (!noteColNames.includes('contact_type')) {
                    db.exec(`ALTER TABLE crm_notes ADD COLUMN contact_type TEXT NOT NULL DEFAULT 'user'`);
                    Logger_1.default.log('[DatabaseService] Migration: added contact_type to crm_notes');
                    needSave = true;
                }
                if (needSave)
                    this.save();
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] crm_notes migration: ${err.message}`);
        }
        // Migration: create employee management tables
        try {
            const empT = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='employees'`);
            if (empT.length === 0) {
                db.exec(`
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
                db.exec(`
                    CREATE TABLE IF NOT EXISTS employee_permissions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        employee_id TEXT NOT NULL,
                        module TEXT NOT NULL,
                        can_access INTEGER NOT NULL DEFAULT 0,
                        UNIQUE(employee_id, module),
                        FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
                    )
                `);
                db.exec(`
                    CREATE TABLE IF NOT EXISTS employee_account_access (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        employee_id TEXT NOT NULL,
                        zalo_id TEXT NOT NULL,
                        UNIQUE(employee_id, zalo_id),
                        FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
                    )
                `);
                db.exec(`
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
                db.exec(`CREATE INDEX IF NOT EXISTS idx_emp_msg_log_employee ON employee_message_log(employee_id)`);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_emp_msg_log_zalo ON employee_message_log(zalo_id)`);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_emp_msg_log_ts ON employee_message_log(timestamp)`);
                db.exec(`
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
                Logger_1.default.log('[DatabaseService] Migration: created employee management tables (employees, employee_permissions, employee_account_access, employee_message_log, employee_sessions)');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] employee tables migration: ${err.message}`);
        }
        // Migration: create employee_groups table + add group_id to employees
        try {
            const grpT = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='employee_groups'`);
            if (grpT.length === 0) {
                db.exec(`
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
                Logger_1.default.log('[DatabaseService] Migration: created employee_groups table');
            }
            // Add group_id column to employees if missing
            const empCols = this.query(`PRAGMA table_info(employees)`);
            if (empCols.length > 0 && !empCols.some((c) => c.name === 'group_id')) {
                db.exec(`ALTER TABLE employees ADD COLUMN group_id TEXT DEFAULT NULL`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added group_id to employees');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] employee_groups migration: ${err.message}`);
        }
        // Migration: add handled_by_employee column to messages if missing
        try {
            const msgCols = this.query(`PRAGMA table_info(messages)`);
            if (msgCols.length > 0 && !msgCols.some((c) => c.name === 'handled_by_employee')) {
                db.exec(`ALTER TABLE messages ADD COLUMN handled_by_employee TEXT DEFAULT NULL`);
                this.save();
                Logger_1.default.log('[DatabaseService] Migration: added handled_by_employee to messages');
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] handled_by_employee migration: ${err.message}`);
        }
    }
    // ─── Account Operations ───────────────────────────────────────────────
    saveAccount(account) {
        if (!this.initialized)
            return;
        const normalizedPhone = this.normalizeVietnamPhone(account.phone || '');
        let encryptedCookies = account.cookies;
        try {
            if (electron_1.safeStorage.isEncryptionAvailable()) {
                encryptedCookies = electron_1.safeStorage.encryptString(account.cookies).toString('base64');
            }
        }
        catch { }
        const isBusiness = account.is_business ?? 0;
        this.run(`INSERT INTO accounts (zalo_id, full_name, avatar_url, phone, is_business, imei, user_agent, cookies, is_active, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(zalo_id) DO UPDATE SET
               full_name=excluded.full_name,
               avatar_url=excluded.avatar_url,
               phone=excluded.phone,
               is_business=excluded.is_business,
               imei=excluded.imei,
               user_agent=excluded.user_agent,
               cookies=excluded.cookies,
               is_active=excluded.is_active,
               last_seen=datetime('now')`, [account.zalo_id, account.full_name, account.avatar_url, normalizedPhone, isBusiness, account.imei, account.user_agent, encryptedCookies, account.is_active, account.created_at]);
    }
    getAccounts() {
        if (!this.initialized)
            return [];
        const accounts = this.query('SELECT * FROM accounts WHERE is_active = 1 ORDER BY created_at');
        return accounts.map((acc) => ({ ...acc, cookies: this.decryptCookies(acc.cookies) }));
    }
    deleteAccount(zaloId) {
        this.run('UPDATE accounts SET is_active = 0 WHERE zalo_id = ?', [zaloId]);
    }
    updateAccountLastSeen(zaloId) {
        this.run('UPDATE accounts SET last_seen = datetime(\'now\') WHERE zalo_id = ?', [zaloId]);
    }
    /** Cập nhật số điện thoại cho tài khoản */
    updateAccountPhone(zaloId, phone) {
        if (!this.initialized)
            return;
        this.run('UPDATE accounts SET phone = ? WHERE zalo_id = ?', [this.normalizeVietnamPhone(phone), zaloId]);
    }
    /** Cập nhật thông tin profile đầy đủ: phone + is_business */
    updateAccountInfo(zaloId, phone, isBusiness) {
        if (!this.initialized)
            return;
        this.run('UPDATE accounts SET phone = ?, is_business = ? WHERE zalo_id = ?', [this.normalizeVietnamPhone(phone), isBusiness, zaloId]);
    }
    /** Kiểm tra tài khoản đã tồn tại trong DB chưa */
    hasAccount(zaloId) {
        if (!this.initialized)
            return false;
        return !!this.queryOne('SELECT id FROM accounts WHERE zalo_id = ?', [zaloId]);
    }
    /** Đánh dấu trạng thái listener (1 = active, 0 = dead/failed) */
    setListenerActive(zaloId, active) {
        this.run('UPDATE accounts SET listener_active = ? WHERE zalo_id = ?', [active ? 1 : 0, zaloId]);
    }
    decryptCookies(encrypted) {
        // Fast-path: already plain JSON (saved before encryption was added, or safeStorage was unavailable)
        const trimmed = encrypted.trimStart();
        if (trimmed.startsWith('[') || trimmed.startsWith('{'))
            return encrypted;
        try {
            if (electron_1.safeStorage.isEncryptionAvailable()) {
                const decrypted = electron_1.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
                // Sanity check: result must be parseable JSON
                JSON.parse(decrypted);
                return decrypted;
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] decryptCookies failed — cookies may be encrypted by a different app instance (${err.message}). Account will need to re-login.`);
        }
        return encrypted;
    }
    // ─── Message Operations ───────────────────────────────────────────────
    /** Check if a message already exists in DB (by msg_id) — used to skip duplicate broadcasts */
    hasMessage(ownerZaloId, msgId) {
        if (!this.initialized || !msgId)
            return false;
        try {
            const rows = this.query('SELECT 1 FROM messages WHERE owner_zalo_id = ? AND msg_id = ? LIMIT 1', [ownerZaloId, msgId]);
            return rows.length > 0;
        }
        catch {
            return false;
        }
    }
    async saveMessage(ownerZaloId, rawMessage) {
        if (!this.initialized)
            return;
        try {
            const isGroup = rawMessage.type === 1;
            // zca-js đã tính sẵn isSelf và threadId đúng:
            // - isSelf = true khi uidFrom == "0" (mình gửi, selfListen)
            // - threadId = data.idTo (nếu mình gửi) hoặc data.uidFrom (nhận từ người khác)
            const isSent = rawMessage.isSelf === true;
            const threadId = rawMessage.threadId || '';
            // DEBUG: log toàn bộ raw fields để phát hiện lỗi
            Logger_1.default.log(`[DB.saveMessage] 📩 raw: isSelf=${rawMessage.isSelf} | type=${rawMessage.type} | threadId="${rawMessage.threadId}" | computed isSent=${isSent} | computed threadId="${threadId}" | data.uidFrom="${rawMessage.data?.uidFrom}" | data.idTo="${rawMessage.data?.idTo}" | data.msgId="${rawMessage.data?.msgId}" | top_keys=[${Object.keys(rawMessage).join(',')}]`);
            // Guard: bỏ qua nếu threadId không hợp lệ
            if (!threadId || threadId === 'undefined') {
                Logger_1.default.warn(`[DB.saveMessage] ⚠️ SKIPPED — invalid threadId="${threadId}". rawMessage.isSelf=${rawMessage.isSelf}, rawMessage.threadId=${rawMessage.threadId}. Có thể main process chưa được rebuild với code mới!`);
                return;
            }
            const contentRaw = rawMessage.data?.content;
            // typeof null === 'object' trong JS — check null/undefined trước khi check typeof object
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
            let quoteData = null;
            const rawQuote = rawMessage.data?.quote;
            if (rawQuote && rawQuote.globalMsgId) {
                const quoteImageUrl = this.extractImageUrlFromQuote(rawQuote);
                // TQuote không có msgType - chỉ có cliMsgType (number), cần convert sang string
                const quoteMsgType = DatabaseService.clientMsgTypeToMsgType(rawQuote.cliMsgType ?? 0);
                quoteData = JSON.stringify({
                    msg: rawQuote.msg ?? '',
                    fromD: rawQuote.fromD || '',
                    attach: rawQuote.attach ?? '',
                    msgType: quoteMsgType,
                    msgId: String(rawQuote.globalMsgId),
                    cliMsgId: String(rawQuote.cliMsgId ?? ''),
                    ownerId: String(rawQuote.ownerId ?? ''),
                    imageUrl: quoteImageUrl,
                });
            }
            this.run(`INSERT OR IGNORE INTO messages
                 (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, local_paths, status, quote_data)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
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
                JSON.stringify(rawMessage.data?.attachments || []),
                '{}',
                'received',
                quoteData,
            ]);
            this.updateContactLastMessage(ownerZaloId, threadId, isGroup ? 1 : 0, content, msgType, timestamp, !isSent);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] saveMessage error: ${err.message}`);
        }
    }
    /** Mark a message as handled by a specific employee */
    setMessageHandledByEmployee(ownerZaloId, msgId, employeeId) {
        if (!this.initialized || !msgId || !employeeId)
            return;
        try {
            this.run(`UPDATE messages SET handled_by_employee = ? WHERE owner_zalo_id = ? AND msg_id = ?`, [employeeId, ownerZaloId, msgId]);
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] setMessageHandledByEmployee error: ${err.message}`);
        }
    }
    /** Lưu tin nhắn hệ thống (sự kiện nhóm) vào DB */
    saveSystemMessage(ownerZaloId, threadId, msgId, content, timestamp, updateMembers) {
        if (!this.initialized)
            return;
        try {
            const attachments = updateMembers && updateMembers.length > 0
                ? JSON.stringify(updateMembers.map(m => ({ id: m.id, dName: m.dName || '', avatar: m.avatar || m.avatar_25 || '' })))
                : '[]';
            this.run(`INSERT OR IGNORE INTO messages
                 (msg_id, cli_msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, local_paths, status, quote_data)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [msgId, null, ownerZaloId, threadId, 1, 'system', content, 'system', timestamp, 0, attachments, '{}', 'received', null]);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] saveSystemMessage error: ${err.message}`);
        }
    }
    getMessages(ownerZaloId, threadId, limit = 50, offset = 0, before) {
        if (!this.initialized)
            return [];
        if (before && before > 0) {
            const msgs = this.query('SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?', [ownerZaloId, threadId, before, limit]);
            Logger_1.default.log(`[DB:getMessages] owner=${ownerZaloId} thread=${threadId} before=${before} → ${msgs.length} msgs`);
            return msgs;
        }
        const msgs = this.query('SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?', [ownerZaloId, threadId, limit, offset]);
        Logger_1.default.log(`[DB:getMessages] owner=${ownerZaloId} thread=${threadId} limit=${limit} offset=${offset} → ${msgs.length} msgs (first: ${msgs[0]?.msg_id || 'none'}, channel: ${msgs[0]?.channel || 'none'})`);
        if (msgs.length === 0) {
            // Diagnostic: check if there are ANY messages for this owner or thread
            try {
                const anyForOwner = this.queryOne(`SELECT COUNT(*) as cnt FROM messages WHERE owner_zalo_id = ?`, [ownerZaloId]);
                const anyForThread = this.queryOne(`SELECT COUNT(*) as cnt FROM messages WHERE thread_id = ?`, [threadId]);
                const fbMsgs = this.queryOne(`SELECT COUNT(*) as cnt FROM fb_messages WHERE thread_id = ?`, [threadId]);
                const sampleOwners = this.query(`SELECT DISTINCT owner_zalo_id, channel FROM messages WHERE thread_id = ? LIMIT 5`, [threadId]);
                Logger_1.default.log(`[DB:getMessages] DIAGNOSTIC: anyForOwner(${ownerZaloId})=${anyForOwner?.cnt} anyForThread(${threadId})=${anyForThread?.cnt} fb_messages(${threadId})=${fbMsgs?.cnt} sampleOwners=${JSON.stringify(sampleOwners)}`);
            }
            catch { }
        }
        return msgs;
    }
    /** Lấy tin nhắn xung quanh 1 timestamp — dùng khi cần scroll đến tin nhắn cũ ngoài trang hiện tại */
    getMessagesAround(ownerZaloId, threadId, timestamp, limit = 50) {
        if (!this.initialized)
            return [];
        const half = Math.floor(limit / 2);
        // Lấy half tin nhắn CŨ hơn hoặc bằng timestamp + half tin nhắn MỚI hơn timestamp
        const older = this.query('SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT ?', [ownerZaloId, threadId, timestamp, half]);
        const newer = this.query('SELECT * FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?', [ownerZaloId, threadId, timestamp, half]);
        // Merge + sort ASC theo timestamp, trả về theo thứ tự cũ → mới
        const combined = [...older, ...newer];
        // Dedup by msg_id (in case timestamp overlap)
        const seen = new Set();
        const deduped = combined.filter(m => {
            if (seen.has(m.msg_id))
                return false;
            seen.add(m.msg_id);
            return true;
        });
        deduped.sort((a, b) => a.timestamp - b.timestamp);
        return deduped;
    }
    /** Lấy tất cả file đính kèm trong một thread — dùng cho tab File */
    getFileMessages(ownerZaloId, threadId, limit = 50, offset = 0) {
        if (!this.initialized)
            return [];
        return this.query(`SELECT msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths, attachments, channel
             FROM messages
             WHERE owner_zalo_id = ? AND thread_id = ?
               AND (
                 msg_type IN ('share.file', 'file', 'share.link')
                 OR (content LIKE '%"title"%' AND content LIKE '%"href"%' AND content LIKE '%"fileExt"%')
                 OR (channel = 'facebook' AND msg_type = 'file' AND attachments IS NOT NULL AND attachments != '[]' AND attachments != '')
               )
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`, [ownerZaloId, threadId, limit, offset]);
    }
    getMediaMessages(ownerZaloId, threadId, limit = 50, offset = 0) {
        if (!this.initialized)
            return [];
        return this.query(`SELECT msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths, attachments, channel
             FROM messages
             WHERE owner_zalo_id = ? AND thread_id = ?
               AND (
                 (
                   msg_type NOT IN ('share.file', 'share.link', 'file', 'chat.recommended', 'chat.recommend',
                                    'webchat', 'text', 'group.poll', 'chat.sticker',
                                    'system.msg', 'notify.unread', 'chat.voice.msg', 'chat.gif')
                   AND (
                     msg_type IN ('photo', 'image', 'chat.photo', 'chat.video.msg')
                     OR (local_paths IS NOT NULL AND local_paths != '{}' AND local_paths != '' AND local_paths != 'null'
                         AND msg_type NOT IN ('share.file','share.link','file'))
                     OR content LIKE '%"rawUrl"%'
                   )
                 )
                 OR (channel = 'facebook' AND msg_type IN ('image', 'photo', 'video', 'sticker', 'animated_image')
                     AND attachments IS NOT NULL AND attachments != '[]' AND attachments != '')
               )
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`, [ownerZaloId, threadId, limit, offset]);
    }
    /** Lấy tất cả ảnh đã lưu trong folder media cho một tài khoản (tất cả threads) */
    getAllLocalMediaMessages(ownerZaloId) {
        if (!this.initialized)
            return [];
        return this.query(`SELECT msg_id, owner_zalo_id, thread_id, sender_id, content, msg_type, timestamp, local_paths
             FROM messages
             WHERE owner_zalo_id = ?
               AND local_paths IS NOT NULL AND local_paths != '{}' AND local_paths != '' AND local_paths != 'null'
             ORDER BY timestamp DESC
             LIMIT 500`, [ownerZaloId]);
    }
    searchMessages(ownerZaloId, query) {
        if (!this.initialized)
            return [];
        return this.query('SELECT * FROM messages WHERE owner_zalo_id = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT 100', [ownerZaloId, `%${query}%`]);
    }
    // ─── Contact Operations ───────────────────────────────────────────────
    saveContact(contact) {
        if (!this.initialized)
            return;
        const normalizedPhone = this.normalizeVietnamPhone(contact.phone || '');
        this.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count, last_message, last_message_time)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
               display_name=excluded.display_name,
               avatar_url=excluded.avatar_url,
               phone=excluded.phone,
               is_friend=excluded.is_friend,
               contact_type=excluded.contact_type`, [contact.owner_zalo_id, contact.contact_id, contact.display_name, contact.avatar_url, normalizedPhone, contact.is_friend, contact.contact_type, contact.unread_count || 0, contact.last_message || '', contact.last_message_time || 0]);
    }
    getContacts(ownerZaloId) {
        if (!this.initialized)
            return [];
        return this.query('SELECT * FROM contacts WHERE owner_zalo_id = ? ORDER BY last_message_time DESC', [ownerZaloId]);
    }
    /** Update one or more flag columns (is_muted, mute_until, is_in_others) for a contact row */
    setContactFlags(ownerZaloId, contactId, flags) {
        if (!this.initialized || !contactId)
            return;
        const sets = [];
        const vals = [];
        if (flags.is_muted !== undefined) {
            sets.push('is_muted=?');
            vals.push(flags.is_muted);
        }
        if (flags.mute_until !== undefined) {
            sets.push('mute_until=?');
            vals.push(flags.mute_until);
        }
        if (flags.is_in_others !== undefined) {
            sets.push('is_in_others=?');
            vals.push(flags.is_in_others);
        }
        if (sets.length === 0)
            return;
        vals.push(ownerZaloId, contactId);
        this.run(`UPDATE contacts SET ${sets.join(', ')} WHERE owner_zalo_id=? AND contact_id=?`, vals);
    }
    /** Get flag columns for a specific contact */
    getContactFlags(ownerZaloId, contactId) {
        if (!this.initialized)
            return null;
        return this.queryOne('SELECT is_muted, mute_until, is_in_others FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [ownerZaloId, contactId]) || null;
    }
    /** Get all contacts that have flags set (for bulk load on startup) */
    getContactsWithFlags(ownerZaloId) {
        if (!this.initialized)
            return [];
        return this.query('SELECT contact_id, is_muted, mute_until, is_in_others FROM contacts WHERE owner_zalo_id=? AND (is_muted=1 OR mute_until>0 OR is_in_others=1)', [ownerZaloId]);
    }
    /**
     * Lưu biệt danh (alias) cho một contact.
     * alias='' nghĩa là xóa biệt danh.
     * Không bao giờ overwrite display_name — alias là field riêng biệt.
     */
    setContactAlias(ownerZaloId, contactId, alias) {
        if (!this.initialized || !contactId)
            return;
        this.run(`UPDATE contacts SET alias=? WHERE owner_zalo_id=? AND contact_id=?`, [alias || '', ownerZaloId, contactId]);
    }
    /**
     * Cập nhật display_name và avatar_url của contact vào DB.
     * Được gọi khi có thông tin tên/ảnh (từ senderInfo trong message event hoặc getUserInfo API).
     */
    updateContactProfile(ownerZaloId, contactId, displayName, avatarUrl, phone = '', contactType = '', gender, birthday) {
        if (!this.initialized || !contactId || contactId === 'undefined')
            return;
        try {
            const normalizedPhone = this.normalizeVietnamPhone(phone || '');
            this.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count)
                 VALUES (?,?,?,?,?,0,?,0)
                 ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                   display_name=CASE WHEN ?!='' THEN ? ELSE contacts.display_name END,
                   avatar_url=CASE WHEN ?!='' THEN ? ELSE contacts.avatar_url END,
                   phone=CASE WHEN ?!='' THEN ? ELSE contacts.phone END,
                   contact_type=CASE WHEN ?!='' THEN ? ELSE contacts.contact_type END`, [
                ownerZaloId, contactId,
                displayName || contactId, avatarUrl || '', normalizedPhone,
                contactType || 'user',
                // ON CONFLICT params: display_name
                displayName, displayName,
                // avatar_url
                avatarUrl, avatarUrl,
                // phone
                normalizedPhone, normalizedPhone,
                // contact_type
                contactType, contactType,
            ]);
            // Update gender & birthday if provided (separate UPDATE to keep INSERT clean)
            if (gender !== undefined && gender !== null) {
                this.run(`UPDATE contacts SET gender=? WHERE owner_zalo_id=? AND contact_id=?`, [gender, ownerZaloId, contactId]);
            }
            if (birthday !== undefined && birthday !== null && birthday !== '') {
                this.run(`UPDATE contacts SET birthday=? WHERE owner_zalo_id=? AND contact_id=?`, [birthday, ownerZaloId, contactId]);
            }
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] updateContactProfile error: ${err.message}`);
        }
    }
    /** Chuyển content thô (JSON) thành chuỗi hiển thị cho last_message */
    formatLastMessageContent(content, msgType) {
        const mt = (msgType || '').toLowerCase();
        // ── Explicit type checks (fast path, no JSON parse needed) ──────────
        if (mt.includes('call'))
            return '📞 Cuộc gọi';
        if (mt === 'chat.voice' || mt.includes('voice') || mt.includes('audio'))
            return '🎙 Tin nhắn thoại';
        if (mt === 'chat.sticker' || mt.includes('sticker'))
            return '🎭 Nhãn dán';
        if (mt.includes('gif'))
            return '🎬 GIF';
        if (mt.includes('video'))
            return '🎥 Video';
        if (mt === 'photo' || mt === 'image' || mt === 'chat.photo' || mt.includes('photo'))
            return '📸 Hình ảnh';
        if (mt === 'share.file' || mt === 'file') {
            try {
                const p = JSON.parse(content);
                return p?.title ? `📂 ${p.title}` : '📂 File đính kèm';
            }
            catch {
                return '📂 File đính kèm';
            }
        }
        // ── System card (chat.ecard): nhắc hẹn, thông báo nhóm ────────────────
        if (mt === 'chat.ecard') {
            try {
                const p = JSON.parse(content);
                if (p?.title)
                    return `🔔 ${p.title}`;
            }
            catch { }
            return '🔔 Thông báo';
        }
        // ── Link types (chat.recommended, chat.link, share.link) ───────────────
        if (mt === 'chat.recommended' || mt === 'chat.recommend' || mt === 'chat.link' || mt === 'share.link') {
            try {
                const p = JSON.parse(content);
                const act = String(p?.action || '');
                // Call actions inside chat.recommended
                if (act === 'recommened.misscall')
                    return '📵 Cuộc gọi nhỡ';
                if (act === 'recommened.calltime') {
                    let prm = {};
                    try {
                        prm = typeof p.params === 'string' ? JSON.parse(p.params) : (p.params || {});
                    }
                    catch { }
                    const secs = prm.duration || 0;
                    if (secs > 0) {
                        const m = Math.floor(secs / 60), s = secs % 60;
                        return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`;
                    }
                    return '📞 Cuộc gọi';
                }
                if (p?.title)
                    return `🔗 ${p.title}`;
            }
            catch { }
            return '🔗 Link';
        }
        // ── Bank card (chat.webcontent) ─────────────────────────────────────────
        if (mt === 'chat.webcontent') {
            try {
                const p = JSON.parse(content);
                if (p?.action === 'zinstant.bankcard')
                    return '🏦 Tài khoản ngân hàng';
                if (p?.title)
                    return p.title;
            }
            catch { }
        }
        // ── Poll ───────────────────────────────────────────────────────────────
        if (mt === 'group.poll')
            return '📊 Bình chọn';
        // ── Todo ──────────────────────────────────────────────────────────────
        if (mt === 'chat.todo')
            return '📝 Công việc';
        // ── JSON content: parse and detect type from fields ──────────────────
        try {
            const p = JSON.parse(content);
            if (p && typeof p === 'object') {
                // chat.recommended call actions (action field inside content)
                const action = String(p.action || '');
                if (action === 'recommened.misscall')
                    return '📵 Cuộc gọi nhỡ';
                if (action === 'recommened.calltime') {
                    let params = {};
                    try {
                        params = typeof p.params === 'string' ? JSON.parse(p.params) : (p.params || {});
                    }
                    catch { }
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
                    if (missed)
                        return '📵 Cuộc gọi nhỡ';
                    if (secs) {
                        const m = Math.floor(secs / 60), s = secs % 60;
                        return `📞 Cuộc gọi (${m > 0 ? `${m}p ` : ''}${s}s)`;
                    }
                    return '📞 Cuộc gọi';
                }
                // Sticker detected from content
                if (p.sticker_id || p.stickerId)
                    return '🎭 Nhãn dán';
                // Link action (recommened.link)
                if (action === 'recommened.link' || action === 'recommended.link') {
                    if (p.title)
                        return `🔗 ${p.title}`;
                    return '🔗 Link';
                }
                // Bank card action
                if (action === 'zinstant.bankcard')
                    return '🏦 Tài khoản ngân hàng';
                // parse params (may be string)
                let params = p.params;
                if (typeof params === 'string') {
                    try {
                        params = JSON.parse(params);
                    }
                    catch {
                        params = null;
                    }
                }
                // File: has title + file-specific fields (fileSize, fileExt, fileUrl, normalUrl)
                if (p.title && (params?.fileSize || params?.fileExt || params?.fileUrl || p.normalUrl || p.fileUrl))
                    return `📂 ${p.title}`;
                // Link heuristic: title + href without image params → link, not image
                if (p.title && p.href && !params?.rawUrl && !params?.hd)
                    return `🔗 ${p.title}`;
                // Image heuristic: has rawUrl/hd, or href/thumb without title
                if (params?.rawUrl || params?.hd)
                    return '🖼 Hình ảnh';
                if ((p.href || p.thumb) && !p.title)
                    return '🖼 Hình ảnh';
                // Plain text stored as JSON string
                if (typeof p === 'string')
                    return p.length > 100 ? p.substring(0, 100) + '...' : p;
                // title without file markers → show title as text (e.g. reminder, link preview)
                if (p.title && typeof p.title === 'string')
                    return p.title;
                if (p.msg && typeof p.msg === 'string')
                    return p.msg;
                if (p.content && typeof p.content === 'string')
                    return p.content;
                return '[Đính kèm]';
            }
            if (typeof p === 'string')
                return p.length > 100 ? p.substring(0, 100) + '...' : p;
        }
        catch { }
        return content.length > 100 ? content.substring(0, 100) + '...' : content;
    }
    /**
     * Khi nhận event vote bình chọn (group.poll action=vote):
     * - Update content của tin nhắn group.poll gốc (cùng pollId) với content mới nhất
     * - Update last_message của contact = "[dName] đã bình chọn: [question]"
     * - KHÔNG tạo tin nhắn mới
     * Trả về true nếu tìm thấy và update được tin nhắn gốc.
     */
    updatePollVoteMessage(ownerZaloId, threadId, pollId, newContent, voterName, question, timestamp, isSent) {
        if (!this.initialized)
            return false;
        try {
            // Tìm tin nhắn group.poll gốc có pollId này
            const rows = this.query(`SELECT msg_id FROM messages
                 WHERE owner_zalo_id=? AND thread_id=? AND msg_type='group.poll'
                 ORDER BY timestamp ASC`, [ownerZaloId, threadId]);
            let foundMsgId = null;
            for (const row of rows) {
                try {
                    const contentRow = this.queryOne(`SELECT content FROM messages WHERE owner_zalo_id=? AND msg_id=?`, [ownerZaloId, row.msg_id]);
                    const c = JSON.parse(contentRow?.content || '{}');
                    const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
                    if (String(params.pollId || '') === String(pollId)) {
                        foundMsgId = row.msg_id;
                        break;
                    }
                }
                catch { }
            }
            if (!foundMsgId)
                return false;
            // Update content và timestamp của tin nhắn gốc
            this.run(`UPDATE messages SET content=?, timestamp=? WHERE owner_zalo_id=? AND msg_id=?`, [newContent, timestamp, ownerZaloId, foundMsgId]);
            // Update last_message của contact
            const displayText = voterName
                ? `${voterName} đã bình chọn: ${question}`
                : `Có người bình chọn: ${question}`;
            const existing = this.queryOne('SELECT unread_count FROM contacts WHERE owner_zalo_id=? AND contact_id=?', [ownerZaloId, threadId]);
            if (existing) {
                const newUnread = !isSent ? (existing.unread_count || 0) + 1 : existing.unread_count;
                this.run('UPDATE contacts SET last_message=?, last_message_time=?, unread_count=? WHERE owner_zalo_id=? AND contact_id=?', [displayText, timestamp, newUnread, ownerZaloId, threadId]);
            }
            return true;
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] updatePollVoteMessage error: ${err.message}`);
            return false;
        }
    }
    updateContactLastMessage(ownerZaloId, contactId, threadType, content, msgType, timestamp, incrementUnread) {
        // Guard: không tạo contact với contactId không hợp lệ
        if (!contactId || contactId === 'undefined' || contactId === 'null' || contactId === '') {
            Logger_1.default.warn(`[DB.updateContactLastMessage] ⚠️ SKIPPED — invalid contactId="${contactId}" for owner=${ownerZaloId}`);
            return;
        }
        const display = this.formatLastMessageContent(content, msgType);
        const unreadIncrement = incrementUnread ? 1 : 0;
        // Chỉ update last_message nếu tin nhắn mới hơn (hoặc chưa có contact)
        // Tránh old messages ghi đè last_message/last_message_time của hội thoại
        this.run(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time)
             VALUES (?,?,?,?,0,?,?,?,?)
             ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
               last_message = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
               last_message_time = CASE WHEN excluded.last_message_time >= COALESCE(contacts.last_message_time, 0) THEN excluded.last_message_time ELSE contacts.last_message_time END,
               unread_count=contacts.unread_count + ?`, [ownerZaloId, contactId, contactId, '', threadType === 1 ? 'group' : 'user', unreadIncrement, display, timestamp, unreadIncrement]);
    }
    /**
     * Cập nhật reaction của 1 user lên 1 tin nhắn (PHP-like accumulation format)
     * Reactions stored as: { total, lastReact, emoji: { emojiChar: { total, users: { userId: count } } } }
     */
    updateMessageReaction(ownerZaloId, msgId, userId, icon) {
        if (!this.initialized || !msgId)
            return;
        try {
            const row = this.queryOne('SELECT reactions FROM messages WHERE owner_zalo_id = ? AND msg_id = ?', [ownerZaloId, String(msgId)]);
            if (!row) {
                Logger_1.default.warn(`[DatabaseService] updateMessageReaction: msg_id=${msgId} not found`);
                return;
            }
            let parsed = {};
            try {
                parsed = JSON.parse(row.reactions || '{}');
            }
            catch { }
            // Migrate old format { userId: emojiChar } → new format
            let reactions;
            if (parsed && parsed.emoji && typeof parsed.emoji === 'object') {
                reactions = parsed;
            }
            else {
                reactions = { total: 0, lastReact: '', emoji: {} };
                for (const [uid, emo] of Object.entries(parsed)) {
                    if (!emo)
                        continue;
                    if (!reactions.emoji[emo])
                        reactions.emoji[emo] = { total: 0, users: {} };
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
                        if (reactions.emoji[emo].total <= 0)
                            delete reactions.emoji[emo];
                    }
                }
            }
            else {
                // PHP-like: accumulate
                if (!reactions.emoji[icon]) {
                    reactions.emoji[icon] = { total: 1, users: { [userId]: 1 } };
                }
                else {
                    reactions.emoji[icon].total++;
                    reactions.emoji[icon].users[userId] = (reactions.emoji[icon].users[userId] || 0) + 1;
                }
                reactions.total++;
                reactions.lastReact = icon;
            }
            this.run('UPDATE messages SET reactions = ? WHERE owner_zalo_id = ? AND msg_id = ?', [JSON.stringify(reactions), ownerZaloId, String(msgId)]);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] updateMessageReaction error: ${err.message}`);
        }
    }
    /**
     * Cập nhật local_paths của một tin nhắn sau khi download ảnh
     */
    updateLocalPaths(ownerZaloId, msgId, localPaths) {
        if (!this.initialized || !msgId)
            return;
        try {
            const row = this.queryOne('SELECT local_paths FROM messages WHERE owner_zalo_id = ? AND msg_id = ?', [ownerZaloId, String(msgId)]);
            if (!row)
                return;
            let existing = {};
            try {
                existing = JSON.parse(row.local_paths || '{}');
            }
            catch { }
            const merged = { ...existing, ...localPaths };
            this.run('UPDATE messages SET local_paths = ? WHERE owner_zalo_id = ? AND msg_id = ?', [JSON.stringify(merged), ownerZaloId, String(msgId)]);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] updateLocalPaths error: ${err.message}`);
        }
    }
    /**
     * Bulk-replace media path prefix in ALL messages after moving the storage folder.
     * Handles both Windows backslash paths (JSON-escaped as \\) and forward-slash paths.
     * Returns the number of messages updated.
     */
    rewriteLocalPaths(oldPrefix, newPrefix) {
        if (!this.initialized || !oldPrefix || !newPrefix || oldPrefix === newPrefix)
            return 0;
        try {
            const variants = [
                [oldPrefix, newPrefix],
                [oldPrefix.replace(/\\/g, '\\\\'), newPrefix.replace(/\\/g, '\\\\')],
                [oldPrefix.replace(/\\/g, '/'), newPrefix.replace(/\\/g, '/')],
            ];
            let updated = 0;
            // UDF: no parameter binding — all logic runs in pure JS callback
            db.function('_rewrite_local_path', (jsonStr) => {
                if (!jsonStr)
                    return jsonStr;
                let text = jsonStr;
                let changed = false;
                for (const [from, to] of variants) {
                    if (text.includes(from)) {
                        text = text.split(from).join(to);
                        changed = true;
                    }
                }
                if (changed)
                    updated++;
                return text;
            });
            db.exec(`UPDATE messages SET local_paths = _rewrite_local_path(local_paths)
                 WHERE local_paths IS NOT NULL AND local_paths != '' AND local_paths != '{}' AND local_paths != 'null'`);
            if (updated > 0)
                this.save();
            Logger_1.default.log(`[DatabaseService] rewriteLocalPaths: updated ${updated} messages`);
            return updated;
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] rewriteLocalPaths error: ${err?.message ?? String(err)}`);
            return 0;
        }
    }
    /**
     * Convert ALL absolute local_paths → "media/zaloId/date/img.jpg" (relative to configFolder).
     * Uses sql.js create_function (UDF) — single SQL UPDATE, zero parameter binding.
     * This bypasses the sql.js Wasm "unknown type undefined" error that occurs when trying
     * to bind rowid values (sql.js does not expose rowid via getAsObject).
     */
    migrateAllAbsolutePathsToRelative() {
        if (!this.initialized)
            return 0;
        let migrationCount = 0;
        try {
            // JS UDF: receives local_paths JSON string, returns transformed string.
            // No Wasm param binding — all transformation runs in JavaScript.
            db.function('_migrate_local_path', (jsonStr) => {
                if (!jsonStr)
                    return jsonStr;
                try {
                    const lp = JSON.parse(jsonStr);
                    let changed = false;
                    for (const key of Object.keys(lp)) {
                        const val = lp[key] || '';
                        if (!val || typeof val !== 'string')
                            continue;
                        const normalized = val.replace(/\\/g, '/');
                        // Skip already-relative paths (no drive letter, no leading '/')
                        if (!/^[A-Za-z]:\//.test(normalized) && !normalized.startsWith('/'))
                            continue;
                        const idx = normalized.lastIndexOf('/media/');
                        if (idx >= 0) {
                            lp[key] = normalized.slice(idx + 1); // → "media/zaloId/date/img.jpg"
                            changed = true;
                            migrationCount++;
                        }
                    }
                    return changed ? JSON.stringify(lp) : jsonStr;
                }
                catch {
                    return jsonStr;
                }
            });
            // Single UPDATE — UDF handles everything, no bound params needed
            db.exec(`UPDATE messages SET local_paths = _migrate_local_path(local_paths)
                 WHERE local_paths IS NOT NULL AND local_paths != '' AND local_paths != '{}' AND local_paths != 'null'`);
            if (migrationCount > 0) {
                this.save();
                Logger_1.default.log(`[DatabaseService] migrateAllAbsolutePathsToRelative: ${migrationCount} paths converted`);
            }
            return migrationCount;
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] migrateAllAbsolutePathsToRelative error: ${err?.message ?? String(err)}`);
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
    migratePathsToRelative(baseDir) {
        if (!this.initialized || !baseDir)
            return 0;
        // Normalise baseDir to forward-slash, with trailing slash
        const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/?$/, '') + '/';
        try {
            const rows = this.query(`SELECT rowid, local_paths FROM messages
                 WHERE local_paths IS NOT NULL
                   AND local_paths != ''
                   AND local_paths != '{}'
                   AND local_paths != 'null'`);
            let updated = 0;
            for (const row of rows) {
                try {
                    const lp = JSON.parse(row.local_paths);
                    let changed = false;
                    for (const key of Object.keys(lp)) {
                        const val = lp[key] || '';
                        if (!val || typeof val !== 'string')
                            continue;
                        // Normalise value to forward-slash for comparison
                        const normalizedVal = val.replace(/\\/g, '/');
                        if (normalizedVal.startsWith(normalizedBase)) {
                            lp[key] = normalizedVal.slice(normalizedBase.length);
                            changed = true;
                        }
                    }
                    if (changed) {
                        this.run('UPDATE messages SET local_paths = ? WHERE rowid = ?', [JSON.stringify(lp), row.rowid]);
                        updated++;
                    }
                }
                catch { /* skip malformed JSON */ }
            }
            Logger_1.default.log(`[DatabaseService] migratePathsToRelative: ${updated} messages converted to relative paths (base="${baseDir}")`);
            return updated;
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] migratePathsToRelative error: ${err.message}`);
            return 0;
        }
    }
    /**
     * Xóa nhiều tin nhắn theo danh sách msgId
     */
    deleteMessages(ownerZaloId, msgIds) {
        if (!this.initialized || !msgIds.length)
            return;
        try {
            const stmt = db.prepare('DELETE FROM messages WHERE owner_zalo_id = ? AND msg_id = ?');
            for (const msgId of msgIds) {
                stmt.run(ownerZaloId, String(msgId));
            }
            this.save();
            Logger_1.default.log(`[DatabaseService] Deleted ${msgIds.length} messages for ${ownerZaloId}`);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] deleteMessages error: ${err.message}`);
        }
    }
    /**
     * Đánh dấu tin nhắn bị xoá bởi trưởng/phó nhóm (không xoá khỏi DB, chỉ set deleted_by)
     */
    markMessageDeletedByAdmin(ownerZaloId, msgIds, deletedByUid) {
        if (!this.initialized || !msgIds.length)
            return;
        try {
            const stmt = db.prepare(`UPDATE messages SET deleted_by = ? WHERE owner_zalo_id = ? AND msg_id = ?`);
            for (const msgId of msgIds) {
                stmt.run(deletedByUid, ownerZaloId, String(msgId));
            }
            this.save();
            Logger_1.default.log(`[DatabaseService] Marked ${msgIds.length} messages deleted_by=${deletedByUid} for ${ownerZaloId}`);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] markMessageDeletedByAdmin error: ${err.message}`);
        }
    }
    getTotalUnread(ownerZaloId) {
        const row = this.queryOne('SELECT SUM(unread_count) as total FROM contacts WHERE owner_zalo_id = ?', [ownerZaloId]);
        return row?.total || 0;
    }
    // ─── Friend Cache Operations ──────────────────────────────────────────
    /** Kiểm tra nhanh 1 userId có trong bảng friends không */
    checkIsFriend(ownerZaloId, userId) {
        if (!this.initialized)
            return false;
        // 1. Check dedicated friends table (populated by saveFriends / addFriend)
        const friendRow = this.queryOne('SELECT 1 FROM friends WHERE owner_zalo_id=? AND user_id=? LIMIT 1', [ownerZaloId, userId]);
        if (friendRow)
            return true;
        // 2. Fallback: check contacts.is_friend flag (populated by Zalo contact sync)
        //    This handles the case where friends table hasn't been synced yet
        const contactRow = this.queryOne('SELECT is_friend FROM contacts WHERE owner_zalo_id=? AND contact_id=? LIMIT 1', [ownerZaloId, userId]);
        return contactRow?.is_friend === 1;
    }
    /** Lưu toàn bộ danh sách bạn bè vào DB (upsert) — batch: single prepare + single save */
    saveFriends(ownerZaloId, friends) {
        if (!this.initialized)
            return;
        const now = Date.now();
        try {
            const stmt = db.prepare(`INSERT INTO friends (owner_zalo_id, user_id, display_name, avatar, phone, updated_at)
                 VALUES (?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   updated_at=excluded.updated_at`);
            for (const f of friends) {
                if (!f.userId)
                    continue;
                stmt.run(ownerZaloId, f.userId, f.displayName || f.zaloName || f.userId, f.avatar || '', this.normalizeVietnamPhone(f.phoneNumber || ''), now);
            }
            this.save();
            Logger_1.default.log(`[DatabaseService] Saved ${friends.length} friends for ${ownerZaloId}`);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] saveFriends error: ${err.message}`);
        }
    }
    /**
     * Batch upsert contacts — single prepare + single disk write.
     * Dùng cho fetchAllFriendsInBackground thay vì gọi saveContact() từng dòng.
     */
    saveContactsBatch(contacts) {
        if (!this.initialized || contacts.length === 0)
            return;
        try {
            const stmt = db.prepare(`INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, phone, is_friend, contact_type, unread_count, last_message, last_message_time)
                 VALUES (?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar_url=excluded.avatar_url,
                   phone=CASE WHEN excluded.phone != '' THEN excluded.phone ELSE contacts.phone END,
                   is_friend=excluded.is_friend,
                   contact_type=excluded.contact_type`);
            for (const c of contacts) {
                const normalizedPhone = this.normalizeVietnamPhone(c.phone || '');
                stmt.run(c.owner_zalo_id, c.contact_id, c.display_name, c.avatar_url, normalizedPhone, c.is_friend, c.contact_type, c.unread_count || 0, c.last_message || '', c.last_message_time || 0);
            }
            this.save();
            Logger_1.default.log(`[DatabaseService] Batch saved ${contacts.length} contacts`);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] saveContactsBatch error: ${err.message}`);
        }
    }
    /**
     * Kiểm tra nhanh 1 contact có tồn tại trong DB không (single-row lookup).
     * Tránh load toàn bộ contacts chỉ để check 1 row.
     */
    getContactById(ownerZaloId, contactId) {
        if (!this.initialized)
            return undefined;
        return this.queryOne('SELECT * FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId]);
    }
    /** Lấy danh sách bạn bè đã cache từ DB */
    getFriends(ownerZaloId) {
        if (!this.initialized)
            return [];
        try {
            const rows = this.query('SELECT user_id, display_name, avatar, phone, updated_at FROM friends WHERE owner_zalo_id = ? ORDER BY display_name', [ownerZaloId]);
            return rows.map(r => ({
                userId: r.user_id,
                displayName: r.display_name || r.user_id,
                avatar: r.avatar || '',
                phoneNumber: r.phone || '',
                updatedAt: r.updated_at || 0,
            }));
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] getFriends error: ${err.message}`);
            return [];
        }
    }
    /** Trả về timestamp lần cuối cache bạn bè, 0 nếu chưa có */
    getFriendsLastFetched(ownerZaloId) {
        if (!this.initialized)
            return 0;
        try {
            const row = this.queryOne('SELECT MAX(updated_at) as max_ts FROM friends WHERE owner_zalo_id = ?', [ownerZaloId]);
            return row?.max_ts || 0;
        }
        catch {
            return 0;
        }
    }
    // ─── Friend Request Cache Operations ─────────────────────────────────
    /**
     * Lưu/cập nhật một lời mời kết bạn vào DB
     * @param direction 'received' = người khác gửi cho mình | 'sent' = mình gửi đi
     */
    upsertFriendRequest(ownerZaloId, request, direction) {
        if (!this.initialized)
            return;
        try {
            this.run(`INSERT INTO friend_requests (owner_zalo_id, user_id, display_name, avatar, phone, direction, msg, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id, direction) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   msg=excluded.msg,
                   updated_at=excluded.updated_at`, [
                ownerZaloId,
                request.userId,
                request.displayName || '',
                request.avatar || '',
                this.normalizeVietnamPhone(request.phone || ''),
                direction,
                request.msg || '',
                request.createdAt || Date.now(),
                Date.now(),
            ]);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] upsertFriendRequest error: ${err.message}`);
        }
    }
    /** Lưu hàng loạt lời mời (replace toàn bộ cho direction đó) */
    saveFriendRequests(ownerZaloId, requests, direction) {
        if (!this.initialized)
            return;
        try {
            // Xóa toàn bộ record cũ cho direction này rồi insert mới
            this.runNoSave(`DELETE FROM friend_requests WHERE owner_zalo_id = ? AND direction = ?`, [ownerZaloId, direction]);
            const now = Date.now();
            const stmt = db.prepare(`INSERT OR IGNORE INTO friend_requests (owner_zalo_id, user_id, display_name, avatar, phone, direction, msg, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`);
            for (const req of requests) {
                if (!req.userId)
                    continue;
                stmt.run(ownerZaloId, req.userId, req.displayName || '', req.avatar || '', this.normalizeVietnamPhone(req.phone || ''), direction, req.msg || '', req.createdAt || now, now);
            }
            this.save();
            Logger_1.default.log(`[DatabaseService] Saved ${requests.length} ${direction} friend requests for ${ownerZaloId}`);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] saveFriendRequests error: ${err.message}`);
        }
    }
    /** Lấy danh sách lời mời từ DB */
    getFriendRequests(ownerZaloId, direction) {
        if (!this.initialized)
            return [];
        try {
            const rows = this.query(`SELECT user_id, display_name, avatar, phone, msg, created_at, updated_at
                 FROM friend_requests
                 WHERE owner_zalo_id = ? AND direction = ?
                 ORDER BY created_at DESC`, [ownerZaloId, direction]);
            return rows.map(r => ({
                userId: r.user_id,
                displayName: r.display_name || r.user_id,
                avatar: r.avatar || '',
                phone: r.phone || '',
                msg: r.msg || '',
                createdAt: r.created_at || 0,
                updatedAt: r.updated_at || 0,
            }));
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] getFriendRequests error: ${err.message}`);
            return [];
        }
    }
    /** Xóa một lời mời kết bạn khỏi DB (khi chấp nhận/từ chối/hủy) */
    removeFriendRequest(ownerZaloId, userId, direction) {
        if (!this.initialized)
            return;
        try {
            this.run(`DELETE FROM friend_requests WHERE owner_zalo_id = ? AND user_id = ? AND direction = ?`, [ownerZaloId, userId, direction]);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] removeFriendRequest error: ${err.message}`);
        }
    }
    /** Thêm bạn bè mới vào bảng friends khi accept lời mời */
    addFriend(ownerZaloId, friend) {
        if (!this.initialized || !friend.userId)
            return;
        try {
            this.run(`INSERT INTO friends (owner_zalo_id, user_id, display_name, avatar, phone, updated_at)
                 VALUES (?,?,?,?,?,?)
                 ON CONFLICT(owner_zalo_id, user_id) DO UPDATE SET
                   display_name=excluded.display_name,
                   avatar=excluded.avatar,
                   phone=excluded.phone,
                   updated_at=excluded.updated_at`, [ownerZaloId, friend.userId, friend.displayName || '', friend.avatar || '', this.normalizeVietnamPhone(friend.phone || ''), Date.now()]);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] addFriend error: ${err.message}`);
        }
    }
    /** Xóa bạn bè khỏi bảng friends */
    removeFriend(ownerZaloId, userId) {
        if (!this.initialized)
            return;
        try {
            this.run(`DELETE FROM friends WHERE owner_zalo_id = ? AND user_id = ?`, [ownerZaloId, userId]);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] removeFriend error: ${err.message}`);
        }
    }
    /** Lấy timestamp lần cuối cache lời mời */
    getFriendRequestsLastFetched(ownerZaloId, direction) {
        if (!this.initialized)
            return 0;
        try {
            const row = this.queryOne('SELECT MAX(updated_at) as max_ts FROM friend_requests WHERE owner_zalo_id = ? AND direction = ?', [ownerZaloId, direction]);
            return row?.max_ts || 0;
        }
        catch {
            return 0;
        }
    }
    markAsRead(ownerZaloId, contactId) {
        if (!this.initialized)
            return;
        this.runNoSave('UPDATE contacts SET unread_count = 0 WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId]);
        this.runNoSave('UPDATE messages SET status = "read" WHERE owner_zalo_id = ? AND thread_id = ? AND is_sent = 0', [ownerZaloId, contactId]);
        this.save();
    }
    /** Đánh dấu tin nhắn là đã thu hồi (is_recalled = 1, giữ nguyên row, lưu nội dung gốc vào recalled_content) */
    markMessageRecalled(ownerZaloId, msgId) {
        if (!this.initialized || !msgId)
            return;
        const recalledContent = JSON.stringify({ msg: 'Tin nhắn đã bị thu hồi' });
        // Lưu nội dung gốc vào recalled_content trước khi ghi đè
        const existing = this.queryOne('SELECT msg_id, content FROM messages WHERE owner_zalo_id = ? AND msg_id = ?', [ownerZaloId, String(msgId)]) || this.queryOne('SELECT msg_id, content FROM messages WHERE owner_zalo_id = ? AND cli_msg_id = ? AND msg_type != \'recalled\'', [ownerZaloId, String(msgId)]);
        const originalContent = existing?.content ?? null;
        const SQL = 'UPDATE messages SET is_recalled = 1, msg_type = "recalled", content = ?, recalled_content = ? WHERE owner_zalo_id = ? AND ';
        if (this.queryOne('SELECT 1 FROM messages WHERE owner_zalo_id = ? AND msg_id = ?', [ownerZaloId, String(msgId)])) {
            this.run(SQL + `msg_id = ?`, [recalledContent, originalContent, ownerZaloId, String(msgId)]);
        }
        else {
            this.run(SQL + `cli_msg_id = ? AND msg_type != 'recalled'`, [recalledContent, originalContent, ownerZaloId, String(msgId)]);
        }
    }
    /** Nếu tin nhắn bị thu hồi là last_message của conversation, cập nhật preview */
    updateLastMessageIfRecalled(ownerZaloId, threadId, msgId) {
        if (!this.initialized || !threadId)
            return;
        try {
            const contact = this.queryOne('SELECT last_message FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, threadId]);
            if (!contact)
                return;
            const lastMsg = this.queryOne('SELECT content, msg_type, timestamp FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND msg_id = ?', [ownerZaloId, threadId, String(msgId)]);
            if (lastMsg) {
                this.run('UPDATE contacts SET last_message = ? WHERE owner_zalo_id = ? AND contact_id = ?', ['Tin nhắn đã bị thu hồi', ownerZaloId, threadId]);
            }
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] updateLastMessageIfRecalled: ${err.message}`);
        }
    }
    getMessageById(ownerZaloId, msgId) {
        if (!this.initialized || !msgId)
            return undefined;
        return this.queryOne('SELECT * FROM messages WHERE owner_zalo_id = ? AND msg_id = ?', [ownerZaloId, String(msgId)]);
    }
    /** Xóa hội thoại khỏi DB (xóa contact + toàn bộ tin nhắn) */
    deleteConversation(ownerZaloId, contactId) {
        if (!this.initialized)
            return;
        try {
            this.runNoSave('DELETE FROM messages WHERE owner_zalo_id = ? AND thread_id = ?', [ownerZaloId, contactId]);
            this.runNoSave('DELETE FROM contacts WHERE owner_zalo_id = ? AND contact_id = ?', [ownerZaloId, contactId]);
            this.save();
            Logger_1.default.log(`[DatabaseService] Deleted conversation ${contactId} for ${ownerZaloId}`);
        }
        catch (err) {
            Logger_1.default.error(`[DatabaseService] deleteConversation error: ${err.message}`);
        }
    }
    // ─── Settings Operations ──────────────────────────────────────────────
    getSetting(key) {
        if (!this.initialized)
            return null;
        const row = this.queryOne('SELECT value FROM app_settings WHERE key = ?', [key]);
        return row?.value ?? null;
    }
    setSetting(key, value) {
        if (!this.initialized)
            return;
        this.run(`INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [key, value]);
    }
    // ─── Image URL Helpers ────────────────────────────────────────────────
    /** Trích xuất URL ảnh từ object content Zalo */
    static extractImageUrlFromContent(contentRaw) {
        if (!contentRaw || typeof contentRaw !== 'object')
            return '';
        let p = contentRaw.params;
        if (typeof p === 'string') {
            try {
                p = JSON.parse(p);
            }
            catch {
                p = null;
            }
        }
        return (p?.hd || p?.rawUrl) || contentRaw.normalUrl || contentRaw.hdUrl || contentRaw.hd || contentRaw.href || contentRaw.thumb || contentRaw.url || '';
    }
    /**
     * Chuyển đổi cliMsgType (số nguyên từ TQuote) sang msgType (string dùng trong zca-js)
     * Ánh xạ ngược của getClientMessageType() trong zca-js/utils.js
     */
    static clientMsgTypeToMsgType(cliMsgType) {
        switch (cliMsgType) {
            case 1: return 'webchat';
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
    extractImageUrlFromQuote(rawQuote) {
        if (!rawQuote)
            return '';
        const attach = rawQuote.attach;
        const msg = rawQuote.msg;
        /** chỉ trả về URL ảnh CDN, tránh trả về href trang web thông thường */
        const isImageUrl = (url) => {
            if (!url)
                return false;
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
                    if (url)
                        return url;
                }
            }
            catch { }
        }
        // 2. Thử msg
        const msgObj = (msg && typeof msg === 'string' && msg !== '' && msg !== 'null')
            ? (() => { try {
                return JSON.parse(msg);
            }
            catch {
                return null;
            } })()
            : (msg && typeof msg === 'object' ? msg : null);
        if (msgObj && typeof msgObj === 'object') {
            const action = String(msgObj.action || '');
            // Parse params để lấy hd/rawUrl
            let p = msgObj.params;
            if (typeof p === 'string') {
                try {
                    p = JSON.parse(p);
                }
                catch {
                    p = null;
                }
            }
            if (p?.hd || p?.rawUrl)
                return p.hd || p.rawUrl;
            // Link preview: chỉ dùng thumb (thumbnail), KHÔNG dùng href (URL trang web)
            if (action === 'recommened.link' || action === 'recommended.link') {
                return String(msgObj.thumb || '');
            }
            // Các loại khác: chỉ trả href nếu trông như ảnh CDN
            const hrefUrl = String(msgObj.href || '');
            if (hrefUrl && isImageUrl(hrefUrl))
                return hrefUrl;
            return String(msgObj.thumb || '');
        }
        return '';
    }
    close() {
        if (db) {
            try {
                db.pragma('wal_checkpoint(TRUNCATE)');
            }
            catch { }
            db.close();
            db = null;
        }
    }
    getDbPath() {
        return this.dbPath;
    }
    // ─── Link Operations ──────────────────────────────────────────────
    saveLink(ownerZaloId, threadId, msgId, url, title, domain, thumbUrl, timestamp) {
        if (!this.initialized)
            return;
        try {
            this.run('INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)', [ownerZaloId, threadId, msgId, url, title, domain, thumbUrl, timestamp]);
        }
        catch (err) {
            Logger_1.default.warn(`[DatabaseService] saveLink error: ${err.message}`);
        }
    }
    getLinks(ownerZaloId, threadId, limit = 50, offset = 0) {
        if (!this.initialized)
            return [];
        // Migrate links table if missing (for existing DBs)
        try {
            const tables = this.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='links'`);
            if (tables.length === 0) {
                db.exec(`CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_zalo_id TEXT NOT NULL, thread_id TEXT NOT NULL, msg_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT DEFAULT '', domain TEXT DEFAULT '', thumb_url TEXT DEFAULT '', timestamp INTEGER NOT NULL, UNIQUE(owner_zalo_id, msg_id))`);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_links_thread ON links(owner_zalo_id, thread_id, timestamp)`);
                this.save();
            }
        }
        catch { }
        // Backfill from messages table — only if no links exist yet for this thread
        try {
            const existing = this.queryOne('SELECT 1 FROM links WHERE owner_zalo_id = ? AND thread_id = ? LIMIT 1', [ownerZaloId, threadId]);
            if (!existing) {
                const msgs = this.query(`SELECT msg_id, content, timestamp FROM messages WHERE owner_zalo_id = ? AND thread_id = ? AND msg_type IN ('chat.recommended','chat.recommend') ORDER BY timestamp DESC LIMIT 300`, [ownerZaloId, threadId]);
                if (msgs.length > 0) {
                    const stmt = db.prepare('INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)');
                    let backfilled = 0;
                    for (const m of msgs) {
                        try {
                            const parsed = JSON.parse(m.content || '{}');
                            if (String(parsed.action || '') === 'recommened.link') {
                                const href = String(parsed.href || parsed.title || '');
                                if (!href)
                                    continue;
                                const params = (() => { try {
                                    const p = parsed.params;
                                    return typeof p === 'string' ? JSON.parse(p) : (p || {});
                                }
                                catch {
                                    return {};
                                } })();
                                const title = String(params.mediaTitle || parsed.title || href);
                                const domain = String(params.src || '');
                                const thumbUrl = String(parsed.thumb || '');
                                stmt.run(ownerZaloId, threadId, m.msg_id, href, title, domain, thumbUrl, m.timestamp);
                                backfilled++;
                            }
                        }
                        catch { }
                    }
                    if (backfilled > 0)
                        this.save();
                }
            }
        }
        catch { }
        // Also backfill from FB text messages containing URLs
        try {
            const fbMsgs = this.query(`SELECT msg_id, content, timestamp FROM messages
                 WHERE owner_zalo_id = ? AND thread_id = ? AND channel = 'facebook'
                   AND msg_type = 'text' AND content IS NOT NULL
                 ORDER BY timestamp DESC LIMIT 500`, [ownerZaloId, threadId]);
            if (fbMsgs.length > 0) {
                const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
                const stmt = db.prepare('INSERT OR IGNORE INTO links (owner_zalo_id, thread_id, msg_id, url, title, domain, thumb_url, timestamp) VALUES (?,?,?,?,?,?,?,?)');
                let backfilled = 0;
                for (const m of fbMsgs) {
                    const text = m.content || '';
                    const matches = text.match(urlRegex);
                    if (!matches)
                        continue;
                    for (const url of matches) {
                        try {
                            const domain = new URL(url).hostname;
                            stmt.run(ownerZaloId, threadId, m.msg_id + '_' + url.slice(0, 20), url, url, domain, '', m.timestamp);
                            backfilled++;
                        }
                        catch { }
                    }
                }
                if (backfilled > 0)
                    this.save();
            }
        }
        catch { }
        return this.query('SELECT * FROM links WHERE owner_zalo_id = ? AND thread_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?', [ownerZaloId, threadId, limit, offset]);
    }
    // ─── Group Member Cache ───────────────────────────────────────────────
    saveGroupMembers(ownerZaloId, groupId, members) {
        if (!this.initialized)
            return;
        const now = Date.now();
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO page_group_member
                (owner_zalo_id, group_id, member_id, display_name, avatar, role, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const m of members) {
            stmt.run(ownerZaloId, groupId, m.memberId, m.displayName || '', m.avatar || '', m.role || 0, now);
        }
        this.save();
        Logger_1.default.log(`[DB] Saved ${members.length} group members for group ${groupId}`);
    }
    /** Insert or update a SINGLE group member without touching others */
    upsertGroupMember(ownerZaloId, groupId, member) {
        if (!this.initialized)
            return;
        db.prepare(`INSERT OR REPLACE INTO page_group_member
                (owner_zalo_id, group_id, member_id, display_name, avatar, role, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ownerZaloId, groupId, member.memberId, member.displayName || '', member.avatar || '', member.role || 0, Date.now());
        this.save();
        Logger_1.default.log(`[DB] Upserted member ${member.memberId} role=${member.role} in group ${groupId}`);
    }
    /** Remove a SINGLE group member from DB */
    removeGroupMember(ownerZaloId, groupId, memberId) {
        if (!this.initialized)
            return;
        db.prepare(`DELETE FROM page_group_member WHERE owner_zalo_id = ? AND group_id = ? AND member_id = ?`).run(ownerZaloId, groupId, memberId);
        this.save();
        Logger_1.default.log(`[DB] Removed member ${memberId} from group ${groupId}`);
    }
    getGroupMembers(ownerZaloId, groupId) {
        if (!this.initialized)
            return [];
        return this.query(`SELECT member_id, display_name, avatar, role, updated_at
             FROM page_group_member
             WHERE owner_zalo_id = ? AND group_id = ?
             ORDER BY role DESC`, [ownerZaloId, groupId]);
    }
    /** Lấy tất cả thành viên nhóm cho tất cả các nhóm của một tài khoản (bulk load) */
    getAllGroupMembers(ownerZaloId) {
        if (!this.initialized)
            return [];
        return this.query(`SELECT group_id, member_id, display_name, avatar, role, updated_at
             FROM page_group_member
             WHERE owner_zalo_id = ?
             ORDER BY group_id, role DESC`, [ownerZaloId]);
    }
    // ─── Sticker Cache (device-wide) ─────────────────────────────────────
    /** Lưu danh sách sticker vào cache DB */
    saveStickers(stickers) {
        if (!this.initialized || !stickers?.length)
            return;
        try {
            const stmt = db.prepare(`INSERT OR REPLACE INTO stickers
                 (sticker_id, cat_id, type, text, sticker_url, sticker_sprite_url, checksum, data_json, unsupported, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`);
            const now = Date.now();
            for (const s of stickers) {
                try {
                    stmt.run(s.id, s.cateId ?? s.catId ?? 0, s.type ?? 0, s.text ?? '', s.stickerUrl ?? '', s.stickerSpriteUrl ?? '', s.checksum ?? '', JSON.stringify(s), 0, now);
                }
                catch (err) {
                    Logger_1.default.warn(`[DB] saveStickers skip id=${s?.id}: ${err.message}`);
                }
            }
            this.save();
        }
        catch (err) {
            Logger_1.default.warn(`[DB] saveStickers error: ${err.message}`);
        }
    }
    /** Lấy sticker theo ID từ cache DB (bao gồm cờ unsupported) */
    getStickerById(stickerId) {
        if (!this.initialized)
            return undefined;
        const row = this.queryOne(`SELECT data_json, unsupported FROM stickers WHERE sticker_id = ?`, [stickerId]);
        if (!row)
            return undefined;
        try {
            const data = JSON.parse(row.data_json);
            if (data)
                data._unsupported = row.unsupported === 1;
            return data;
        }
        catch {
            return undefined;
        }
    }
    /** Đánh dấu sticker là không hỗ trợ (tránh gọi API lại) */
    markStickerUnsupported(stickerId) {
        if (!this.initialized)
            return;
        // Nếu sticker chưa tồn tại, tạo bản ghi tối thiểu
        this.run(`INSERT OR IGNORE INTO stickers (sticker_id, unsupported, data_json, updated_at) VALUES (?,1,'{}',?)`, [stickerId, Date.now()]);
        this.run(`UPDATE stickers SET unsupported = 1, updated_at = ? WHERE sticker_id = ?`, [Date.now(), stickerId]);
    }
    /** Kiểm tra sticker có bị đánh dấu unsupported không */
    isStickerUnsupported(stickerId) {
        if (!this.initialized)
            return false;
        const row = this.queryOne(`SELECT unsupported FROM stickers WHERE sticker_id = ?`, [stickerId]);
        return row?.unsupported === 1;
    }
    // ─── Sticker Packs ───────────────────────────────────────────────────
    /** Lưu sticker packs vào DB */
    saveStickerPacks(packs) {
        if (!this.initialized || !packs?.length)
            return;
        try {
            const stmt = db.prepare(`INSERT OR REPLACE INTO sticker_packs
                 (cat_id, name, thumb_url, sticker_count, data_json, updated_at)
                 VALUES (?,?,?,?,?,?)`);
            const now = Date.now();
            for (const p of packs) {
                try {
                    stmt.run(p.catId ?? p.cat_id ?? 0, p.name ?? '', p.thumbUrl ?? p.thumb_url ?? '', p.stickerCount ?? p.sticker_count ?? 0, JSON.stringify(p), now);
                }
                catch (err) {
                    Logger_1.default.warn(`[DB] saveStickerPacks skip catId=${p?.catId}: ${err.message}`);
                }
            }
            this.save();
        }
        catch (err) {
            Logger_1.default.warn(`[DB] saveStickerPacks error: ${err.message}`);
        }
    }
    /** Lấy tất cả sticker packs đã cache */
    getStickerPacks() {
        if (!this.initialized)
            return [];
        const rows = this.query(`SELECT data_json, updated_at FROM sticker_packs ORDER BY updated_at DESC`);
        return rows.map((r) => {
            try {
                const data = JSON.parse(r.data_json);
                data._updatedAt = r.updated_at;
                return data;
            }
            catch {
                return null;
            }
        }).filter(Boolean);
    }
    /** Lấy tất cả sticker thuộc một pack (catId) */
    getStickersByPackId(catId) {
        if (!this.initialized)
            return [];
        const rows = this.query(`SELECT data_json, unsupported FROM stickers WHERE cat_id = ? AND unsupported = 0 ORDER BY sticker_id`, [catId]);
        return rows.map((r) => {
            try {
                return JSON.parse(r.data_json);
            }
            catch {
                return null;
            }
        }).filter(Boolean);
    }
    /** Lấy danh sách sticker gần dùng (kèm đầy đủ thông tin) */
    getRecentStickers(limit = 30) {
        if (!this.initialized)
            return [];
        const rows = this.query(`SELECT s.data_json
             FROM stickers s
             INNER JOIN recent_stickers rs ON rs.sticker_id = s.sticker_id
             ORDER BY rs.used_at DESC
             LIMIT ?`, [limit]);
        return rows.map((r) => { try {
            return JSON.parse(r.data_json);
        }
        catch {
            return null;
        } }).filter(Boolean);
    }
    /** Thêm/cập nhật sticker vào danh sách gần dùng */
    addRecentSticker(stickerId) {
        if (!this.initialized)
            return;
        this.runNoSave(`INSERT OR REPLACE INTO recent_stickers (sticker_id, used_at) VALUES (?,?)`, [stickerId, Date.now()]);
        // Giữ tối đa 50 sticker gần dùng
        this.runNoSave(`DELETE FROM recent_stickers WHERE sticker_id NOT IN (
               SELECT sticker_id FROM recent_stickers ORDER BY used_at DESC LIMIT 50
             )`);
        this.save();
    }
    // ─── Keyword → Sticker IDs Cache ──────────────────────────────────────
    /** Lưu keyword → stickerIds mapping */
    saveKeywordStickers(keyword, stickerIds) {
        if (!this.initialized || !keyword)
            return;
        try {
            this.run(`INSERT OR REPLACE INTO keyword_stickers (keyword, sticker_ids, updated_at) VALUES (?,?,?)`, [keyword.toLowerCase().trim(), JSON.stringify(stickerIds), Date.now()]);
        }
        catch (err) {
            Logger_1.default.warn(`[DB] saveKeywordStickers error: ${err.message}`);
        }
    }
    /** Lấy stickerIds theo keyword (null nếu chưa cache) */
    getKeywordStickers(keyword) {
        if (!this.initialized || !keyword)
            return null;
        const row = this.queryOne(`SELECT sticker_ids, updated_at FROM keyword_stickers WHERE keyword = ?`, [keyword.toLowerCase().trim()]);
        if (!row)
            return null;
        try {
            return JSON.parse(row.sticker_ids);
        }
        catch {
            return null;
        }
    }
    /** Lấy sticker details theo danh sách IDs từ bảng stickers */
    getStickersByIds(stickerIds) {
        if (!this.initialized || !stickerIds?.length)
            return [];
        // SQLite placeholders
        const placeholders = stickerIds.map(() => '?').join(',');
        const rows = this.query(`SELECT data_json FROM stickers WHERE sticker_id IN (${placeholders}) AND unsupported = 0`, stickerIds);
        return rows.map((r) => {
            try {
                return JSON.parse(r.data_json);
            }
            catch {
                return null;
            }
        }).filter(Boolean);
    }
    /** Lấy tất cả cat_id có sticker trong cache (để build store từ DB) */
    getAllCachedPackSummaries() {
        if (!this.initialized)
            return [];
        const rows = this.query(`SELECT cat_id, COUNT(*) as cnt,
                    (SELECT sticker_url FROM stickers s2 WHERE s2.cat_id = s.cat_id AND s2.sticker_url != '' LIMIT 1) as thumb
             FROM stickers s
             WHERE cat_id > 0 AND unsupported = 0
             GROUP BY cat_id
             HAVING cnt >= 1
             ORDER BY MAX(updated_at) DESC`);
        return rows.map((r) => ({
            catId: r.cat_id,
            count: r.cnt,
            thumbUrl: r.thumb || '',
        }));
    }
    // ─── Pinned Messages ──────────────────────────────────────────────────────
    /** Lấy danh sách tin ghim (mới nhất trước) */
    getPinnedMessages(ownerZaloId, threadId) {
        if (!this.initialized)
            return [];
        return this.query(`SELECT * FROM pinned_messages WHERE owner_zalo_id=? AND thread_id=? ORDER BY pinned_at DESC`, [ownerZaloId, threadId]);
    }
    /** Ghim một tin nhắn */
    pinMessage(ownerZaloId, threadId, pin) {
        if (!this.initialized)
            return;
        this.run(`INSERT OR REPLACE INTO pinned_messages
             (owner_zalo_id, thread_id, msg_id, msg_type, content, preview_text, preview_image, sender_id, sender_name, timestamp, pinned_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [ownerZaloId, threadId, pin.msgId, pin.msgType, pin.content,
            pin.previewText, pin.previewImage, pin.senderId, pin.senderName,
            pin.timestamp, Date.now()]);
    }
    /** Bỏ ghim một tin nhắn */
    unpinMessage(ownerZaloId, threadId, msgId) {
        if (!this.initialized)
            return;
        this.run(`DELETE FROM pinned_messages WHERE owner_zalo_id=? AND thread_id=? AND msg_id=?`, [ownerZaloId, threadId, msgId]);
    }
    /** Đưa tin ghim lên đầu (cập nhật pinned_at về now) */
    bringPinnedToTop(ownerZaloId, threadId, msgId) {
        if (!this.initialized)
            return;
        this.run(`UPDATE pinned_messages SET pinned_at=? WHERE owner_zalo_id=? AND thread_id=? AND msg_id=?`, [Date.now(), ownerZaloId, threadId, msgId]);
    }
    /** Lấy tin nhắn theo msg_type trong một thread (mới nhất trước) */
    getMessagesByType(ownerZaloId, threadId, msgType, limit = 100) {
        if (!this.initialized)
            return [];
        return this.query(`SELECT * FROM messages WHERE owner_zalo_id=? AND thread_id=? AND msg_type=? AND is_recalled=0
             ORDER BY timestamp DESC LIMIT ?`, [ownerZaloId, threadId, msgType, limit]);
    }
    // ─── Local Quick Messages ──────────────────────────────────────────────
    /** Lấy toàn bộ tin nhắn nhanh local theo zaloId */
    getLocalQuickMessages(ownerZaloId) {
        if (!this.initialized)
            return [];
        const rows = this.query(`SELECT * FROM local_quick_messages WHERE owner_zalo_id=? ORDER BY keyword ASC`, [ownerZaloId]);
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
    upsertLocalQuickMessage(ownerZaloId, item) {
        if (!this.initialized)
            return 0;
        const now = Date.now();
        const existing = this.queryOne(`SELECT id FROM local_quick_messages WHERE owner_zalo_id=? AND keyword=?`, [ownerZaloId, item.keyword]);
        if (existing) {
            this.run(`UPDATE local_quick_messages SET title=?, media_json=?, updated_at=? WHERE owner_zalo_id=? AND keyword=?`, [item.title, item.media ? JSON.stringify(item.media) : null, now, ownerZaloId, item.keyword]);
            return existing.id;
        }
        else {
            this.run(`INSERT INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`, [ownerZaloId, item.keyword, item.title, item.media ? JSON.stringify(item.media) : null, now, now]);
            const row = this.queryOne(`SELECT id FROM local_quick_messages WHERE owner_zalo_id=? AND keyword=?`, [ownerZaloId, item.keyword]);
            return row?.id || 0;
        }
    }
    /** Xóa tin nhắn nhanh local theo id */
    deleteLocalQuickMessage(ownerZaloId, id) {
        if (!this.initialized)
            return;
        this.run(`DELETE FROM local_quick_messages WHERE owner_zalo_id=? AND id=?`, [ownerZaloId, id]);
    }
    /** Xóa tất cả và upsert lại toàn bộ (dùng khi sync từ Zalo) */
    bulkReplaceLocalQuickMessages(ownerZaloId, items) {
        if (!this.initialized)
            return;
        this.runNoSave(`DELETE FROM local_quick_messages WHERE owner_zalo_id=?`, [ownerZaloId]);
        const now = Date.now();
        const stmt = db.prepare(`INSERT OR REPLACE INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at) VALUES (?,?,?,?,?,?)`);
        for (const item of items) {
            stmt.run(ownerZaloId, item.keyword, item.title, item.media ? JSON.stringify(item.media) : null, now, now);
        }
        this.save();
    }
    /** Clone toàn bộ local quick messages từ một account sang account khác */
    cloneLocalQuickMessages(sourceZaloId, targetZaloId) {
        if (!this.initialized)
            return 0;
        try {
            const rows = this.query(`SELECT keyword, title, media_json FROM local_quick_messages WHERE owner_zalo_id=? ORDER BY keyword ASC`, [sourceZaloId]);
            if (rows.length === 0)
                return 0;
            const now = Date.now();
            const stmt = db.prepare(`INSERT OR REPLACE INTO local_quick_messages (owner_zalo_id, keyword, title, media_json, created_at, updated_at)
                 VALUES (?,?,?,?,?,?)`);
            let count = 0;
            for (const row of rows) {
                try {
                    stmt.run(targetZaloId, row.keyword, row.title, row.media_json, now, now);
                    count++;
                }
                catch { }
            }
            this.save();
            return count;
        }
        catch (err) {
            Logger_1.default.error(`[DB] cloneLocalQuickMessages: ${err.message}`);
            return 0;
        }
    }
    /** Clone labels assigned to sourceZaloId to targetZaloId.
     *  Since labels are stored with comma-separated 'page_ids', this means appending targetZaloId to relevant labels.
     */
    cloneLocalLabels(sourceZaloId, targetZaloId) {
        if (!this.initialized)
            return 0;
        let count = 0;
        try {
            const labels = this.query(`SELECT * FROM local_labels WHERE page_ids LIKE ?`, [`%${sourceZaloId}%`]);
            for (const label of labels) {
                const pids = (label.page_ids || '').split(',').filter(Boolean);
                // 👉 Nếu đã có target → bỏ qua
                if (pids.includes(targetZaloId))
                    continue;
                // 👉 Check target đã có label cùng name chưa
                const existed = this.queryOne(`SELECT * FROM local_labels
                 WHERE name = ?
                 AND page_ids LIKE ?
                 LIMIT 1`, [label.name, `%${targetZaloId}%`]);
                if (existed)
                    continue;
                // 👉 thêm target vào label hiện tại
                pids.push(targetZaloId);
                const newIds = pids.join(',');
                this.runNoSave(`UPDATE local_labels SET page_ids=?, updated_at=? WHERE id=?`, [newIds, Date.now(), label.id]);
                count++;
            }
            if (count > 0)
                this.save();
            return count;
        }
        catch (err) {
            Logger_1.default.error(`[DB] cloneLocalLabels: ${err.message}`);
            return 0;
        }
    }
    /** Lấy toàn bộ quick messages của TẤT CẢ accounts — dùng cho Settings global list */
    getAllLocalQuickMessages() {
        if (!this.initialized)
            return [];
        try {
            const rows = this.query(`SELECT * FROM local_quick_messages ORDER BY owner_zalo_id ASC, sort_order ASC, keyword ASC`);
            return rows.map((r) => {
                const mediaObj = r.media_json ? JSON.parse(r.media_json) : null;
                const localFiles = mediaObj?.localFiles?.length ? mediaObj.localFiles : undefined;
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
        }
        catch (err) {
            Logger_1.default.error(`[DB] getAllLocalQuickMessages: ${err.message}`);
            return [];
        }
    }
    /** Bật/tắt trạng thái hoạt động của một quick message */
    setLocalQMActive(id, isActive) {
        if (!this.initialized)
            return;
        this.run(`UPDATE local_quick_messages SET is_active=?, updated_at=? WHERE id=?`, [isActive, Date.now(), id]);
    }
    /** Cập nhật sort_order của một quick message */
    setLocalQMOrder(id, sortOrder) {
        if (!this.initialized)
            return;
        this.run(`UPDATE local_quick_messages SET sort_order=?, updated_at=? WHERE id=?`, [sortOrder, Date.now(), id]);
    }
    // ─── Local Labels ──────────────────────────────────────────────────────────
    /** Lấy tất cả local labels.
     *  Nếu zaloId được cung cấp → chỉ trả về labels áp dụng cho account đó (page_ids rỗng = global). */
    getLocalLabels(zaloId) {
        if (!this.initialized)
            return [];
        try {
            if (!zaloId) {
                return this.query(`SELECT * FROM local_labels ORDER BY sort_order ASC, name ASC`);
            }
            return this.query(`SELECT * FROM local_labels WHERE page_ids = '' OR page_ids LIKE ? ORDER BY sort_order ASC, name ASC`, [`%${zaloId}%`]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getLocalLabels: ${err.message}`);
            return [];
        }
    }
    /** Tạo hoặc cập nhật một local label. Trả về id */
    upsertLocalLabel(label) {
        if (!this.initialized)
            return -1;
        try {
            const now = Date.now();
            const tc = label.textColor || '#FFFFFF';
            const shortcut = label.shortcut || '';
            // 👉 Check trùng name trong từng page_id
            const pageIds = (label.pageIds || '').split(',').filter(Boolean);
            for (const pid of pageIds) {
                const existed = this.queryOne(`SELECT * FROM local_labels
                 WHERE name = ?
                 AND page_ids LIKE ?
                 AND (${label.id ? 'id != ?' : '1=1'})
                 LIMIT 1`, label.id ? [label.name, `%${pid}%`, label.id] : [label.name, `%${pid}%`]);
                if (existed) {
                    // đã tồn tại label cùng tên trong page → bỏ qua
                    return existed.id;
                }
            }
            if (label.id) {
                this.run(`UPDATE local_labels
                     SET name=?, color=?, text_color=?, emoji=?, page_ids=?,
                         is_active=COALESCE(?,is_active),
                         sort_order=COALESCE(?,sort_order),
                         shortcut=?,
                         updated_at=?
                     WHERE id=?`, [
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
                ]);
                return label.id;
            }
            else {
                this.run(`INSERT INTO local_labels
                     (name, color, text_color, emoji, page_ids, is_active, sort_order, shortcut, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`, [
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
                ]);
                return this.queryOne(`SELECT last_insert_rowid() as id`)?.id ?? -1;
            }
        }
        catch (err) {
            Logger_1.default.error(`[DB] upsertLocalLabel: ${err.message}`);
            return -1;
        }
    }
    /** Bật/tắt trạng thái hoạt động của một label */
    setLocalLabelActive(id, isActive) {
        if (!this.initialized)
            return;
        this.run(`UPDATE local_labels SET is_active=?, updated_at=? WHERE id=?`, [isActive, Date.now(), id]);
    }
    /** Cập nhật sort_order của một label */
    setLocalLabelOrder(id, sortOrder) {
        if (!this.initialized)
            return;
        this.run(`UPDATE local_labels SET sort_order=?, updated_at=? WHERE id=?`, [sortOrder, Date.now(), id]);
    }
    /** Xóa một local label (cascade xóa assignments) */
    deleteLocalLabel(id) {
        if (!this.initialized)
            return;
        try {
            this.runNoSave(`DELETE FROM local_label_threads WHERE label_id=?`, [id]);
            this.runNoSave(`DELETE FROM local_labels WHERE id=?`, [id]);
            this.save();
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteLocalLabel: ${err.message}`);
        }
    }
    /** Lấy tất cả thread assignments của một account */
    getLocalLabelThreads(ownerZaloId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT label_id, thread_id FROM local_label_threads WHERE owner_zalo_id=?`, [ownerZaloId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getLocalLabelThreads: ${err.message}`);
            return [];
        }
    }
    /** Gán label cho một thread */
    assignLocalLabelToThread(ownerZaloId, labelId, threadId) {
        if (!this.initialized)
            return;
        try {
            this.run(`INSERT OR IGNORE INTO local_label_threads (owner_zalo_id, label_id, thread_id, created_at) VALUES (?,?,?,?)`, [ownerZaloId, labelId, threadId, Date.now()]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] assignLocalLabelToThread: ${err.message}`);
        }
    }
    /** Gỡ label khỏi một thread */
    removeLocalLabelFromThread(ownerZaloId, labelId, threadId) {
        if (!this.initialized)
            return;
        try {
            this.run(`DELETE FROM local_label_threads WHERE owner_zalo_id=? AND label_id=? AND thread_id=?`, [ownerZaloId, labelId, threadId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] removeLocalLabelFromThread: ${err.message}`);
        }
    }
    /** Lấy tất cả local labels đang được gán cho một thread */
    getThreadLocalLabels(ownerZaloId, threadId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT ll.* FROM local_labels ll
                 INNER JOIN local_label_threads llt ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id=? AND llt.thread_id=?
                 ORDER BY ll.name ASC`, [ownerZaloId, threadId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getThreadLocalLabels: ${err.message}`);
            return [];
        }
    }
    // ─── CRM Methods ─────────────────────────────────────────────────────────
    /** Notes */
    getCRMNotes(ownerZaloId, contactId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM crm_notes WHERE owner_zalo_id=? AND contact_id=? ORDER BY updated_at DESC`, [ownerZaloId, contactId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getCRMNotes: ${err.message}`);
            return [];
        }
    }
    saveCRMNote(note) {
        if (!this.initialized)
            return 0;
        try {
            const now = Date.now();
            const contactType = note.contact_type ?? 'user';
            const topicId = note.topic_id ?? null;
            if (note.id) {
                this.run(`UPDATE crm_notes SET content=?, topic_id=?, updated_at=? WHERE id=? AND owner_zalo_id=?`, [note.content, topicId, now, note.id, note.owner_zalo_id]);
                return note.id;
            }
            else {
                return this.runInsert(`INSERT INTO crm_notes (owner_zalo_id, contact_id, contact_type, content, topic_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`, [note.owner_zalo_id, note.contact_id, contactType, note.content, topicId, now, now]);
            }
        }
        catch (err) {
            Logger_1.default.error(`[DB] saveCRMNote: ${err.message}`);
            return 0;
        }
    }
    /** Cập nhật topicId cho một ghi chú nhóm sau khi API trả về */
    setNoteTopicId(noteId, ownerZaloId, topicId) {
        if (!this.initialized)
            return;
        try {
            this.run(`UPDATE crm_notes SET topic_id=? WHERE id=? AND owner_zalo_id=?`, [topicId, noteId, ownerZaloId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] setNoteTopicId: ${err.message}`);
        }
    }
    deleteCRMNote(noteId, ownerZaloId) {
        if (!this.initialized)
            return;
        try {
            this.run(`DELETE FROM crm_notes WHERE id=? AND owner_zalo_id=?`, [noteId, ownerZaloId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteCRMNote: ${err.message}`);
        }
    }
    /** Campaigns */
    getCRMCampaigns(ownerZaloId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT c.*,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id) as total_contacts,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='sent') as sent_count,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='pending') as pending_count,
                    (SELECT COUNT(*) FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='failed') as failed_count
                 FROM crm_campaigns c WHERE c.owner_zalo_id=? ORDER BY c.created_at DESC`, [ownerZaloId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getCRMCampaigns: ${err.message}`);
            return [];
        }
    }
    getCRMCampaign(campaignId) {
        if (!this.initialized)
            return null;
        try {
            const rows = this.query(`SELECT * FROM crm_campaigns WHERE id=?`, [campaignId]);
            return rows[0] || null;
        }
        catch (err) {
            Logger_1.default.error(`[DB] getCRMCampaign: ${err.message}`);
            return null;
        }
    }
    saveCRMCampaign(campaign) {
        if (!this.initialized)
            return 0;
        try {
            const now = Date.now();
            const type = campaign.campaign_type || 'message';
            const frMsg = campaign.friend_request_message || '';
            const status = campaign.status || 'draft';
            const mixedCfg = campaign.mixed_config || '{}';
            if (campaign.id) {
                this.run(`UPDATE crm_campaigns SET name=?, template_message=?, friend_request_message=?, campaign_type=?, mixed_config=?, status=?, delay_seconds=?, updated_at=? WHERE id=? AND owner_zalo_id=?`, [campaign.name, campaign.template_message || '', frMsg, type, mixedCfg, status, campaign.delay_seconds || 60, now, campaign.id, campaign.owner_zalo_id]);
                return campaign.id;
            }
            else {
                return this.runInsert(`INSERT INTO crm_campaigns (owner_zalo_id, name, template_message, friend_request_message, campaign_type, mixed_config, status, delay_seconds, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [campaign.owner_zalo_id, campaign.name, campaign.template_message, frMsg, type, mixedCfg, campaign.status || 'draft', campaign.delay_seconds || 60, now, now]);
            }
        }
        catch (err) {
            Logger_1.default.error(`[DB] saveCRMCampaign: ${err.message}`);
            return 0;
        }
    }
    updateCRMCampaignStatus(campaignId, status) {
        if (!this.initialized)
            return;
        try {
            this.run(`UPDATE crm_campaigns SET status=?, updated_at=? WHERE id=?`, [status, Date.now(), campaignId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] updateCRMCampaignStatus: ${err.message}`);
        }
    }
    deleteCRMCampaign(campaignId, ownerZaloId) {
        if (!this.initialized)
            return;
        try {
            this.runNoSave(`DELETE FROM crm_campaign_contacts WHERE campaign_id=?`, [campaignId]);
            this.runNoSave(`DELETE FROM crm_campaigns WHERE id=? AND owner_zalo_id=?`, [campaignId, ownerZaloId]);
            this.save();
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteCRMCampaign: ${err.message}`);
        }
    }
    cloneCRMCampaign(campaignId, ownerZaloId, includeContacts, newName) {
        if (!this.initialized)
            return 0;
        try {
            const orig = this.getCRMCampaign(campaignId);
            if (!orig) {
                Logger_1.default.warn(`[DB] cloneCRMCampaign: campaign ${campaignId} not found`);
                return 0;
            }
            const newId = this.saveCRMCampaign({
                ...orig,
                id: 0,
                name: (newName?.trim()) || ((orig.name || '') + ' (bản sao)'),
                status: 'draft',
                owner_zalo_id: ownerZaloId,
            });
            if (!newId) {
                Logger_1.default.warn(`[DB] cloneCRMCampaign: saveCRMCampaign returned 0`);
                return 0;
            }
            if (includeContacts) {
                const contacts = this.getCampaignContacts(campaignId);
                if (contacts.length > 0) {
                    // Batch insert via a prepared statement to avoid per-row save() calls
                    const stmt = db.prepare(`INSERT OR IGNORE INTO crm_campaign_contacts
                         (campaign_id, owner_zalo_id, contact_id, display_name, avatar, status, sent_at, retry_count, error)
                         VALUES (?,?,?,?,?,?,?,?,?)`);
                    for (const c of contacts) {
                        stmt.run(newId, ownerZaloId, c.contact_id ?? '', c.display_name ?? '', c.avatar ?? '', 'pending', // luôn reset về pending khi clone
                        0, // sent_at
                        0, // retry_count
                        '');
                    }
                    Logger_1.default.log(`[DB] cloneCRMCampaign: copied ${contacts.length} contacts to campaign ${newId}`);
                }
            }
            return newId;
        }
        catch (err) {
            Logger_1.default.error(`[DB] cloneCRMCampaign: ${err.message}`);
            return 0;
        }
    }
    addCampaignContacts(campaignId, ownerZaloId, contacts) {
        if (!this.initialized || !contacts.length)
            return;
        try {
            const stmt = db.prepare(`INSERT OR IGNORE INTO crm_campaign_contacts (campaign_id, owner_zalo_id, contact_id, display_name, avatar, status, sent_at, retry_count, error) VALUES (?,?,?,?,?,'pending',0,0,'')`);
            for (const c of contacts) {
                stmt.run(campaignId, ownerZaloId, c.contactId, c.displayName || '', c.avatar || '');
            }
            this.save();
        }
        catch (err) {
            Logger_1.default.error(`[DB] addCampaignContacts: ${err.message}`);
        }
    }
    getCampaignContacts(campaignId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM crm_campaign_contacts WHERE campaign_id=? ORDER BY id`, [campaignId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getCampaignContacts: ${err.message}`);
            return [];
        }
    }
    updateCampaignContactStatus(id, status, error) {
        if (!this.initialized)
            return;
        try {
            const sentAt = status === 'sent' ? Date.now() : 0;
            const incRetry = status === 'failed' ? 1 : 0;
            this.run(`UPDATE crm_campaign_contacts SET status=?, sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END, error=?, retry_count=retry_count+? WHERE id=?`, [status, status, sentAt, error || '', incRetry, id]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] updateCampaignContactStatus: ${err.message}`);
        }
    }
    /** Lấy item tiếp theo cần gửi cho account này */
    getNextPendingCampaignContact(ownerZaloId) {
        if (!this.initialized)
            return null;
        try {
            const rows = this.query(`SELECT cc.*, c.template_message, c.delay_seconds, c.campaign_type, c.friend_request_message, c.mixed_config,
                    COALESCE(cont.phone, fr.phone, '') as phone,
                    COALESCE(cont.contact_type, 'user') as contact_type
                 FROM crm_campaign_contacts cc
                 JOIN crm_campaigns c ON c.id=cc.campaign_id
                 LEFT JOIN contacts cont ON cont.owner_zalo_id=cc.owner_zalo_id AND cont.contact_id=cc.contact_id
                 LEFT JOIN friends fr ON fr.owner_zalo_id=cc.owner_zalo_id AND fr.user_id=cc.contact_id
                 WHERE cc.owner_zalo_id=? AND cc.status='pending' AND c.status='active' AND cc.retry_count < 3
                 ORDER BY cc.id LIMIT 1`, [ownerZaloId]);
            return rows[0] || null;
        }
        catch (err) {
            Logger_1.default.error(`[DB] getNextPendingCampaignContact: ${err.message}`);
            return null;
        }
    }
    /** Kiểm tra có campaign nào đang active không */
    hasActiveCampaigns(ownerZaloId) {
        if (!this.initialized)
            return false;
        try {
            const rows = this.query(`SELECT 1 FROM crm_campaigns c
                 WHERE c.owner_zalo_id=? AND c.status='active'
                 AND EXISTS (SELECT 1 FROM crm_campaign_contacts cc WHERE cc.campaign_id=c.id AND cc.status='pending')
                 LIMIT 1`, [ownerZaloId]);
            return rows.length > 0;
        }
        catch {
            return false;
        }
    }
    /** Lấy danh sách distinct owner_zalo_id có campaign đang active (dùng khi resume sau restart) */
    getActiveCampaignOwners() {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT DISTINCT owner_zalo_id FROM crm_campaigns WHERE status='active'`, []).map((r) => r.owner_zalo_id);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getActiveCampaignOwners: ${err.message}`);
            return [];
        }
    }
    /** Send Log */
    saveSendLog(log) {
        if (!this.initialized)
            return;
        try {
            this.run(`INSERT INTO crm_send_log (owner_zalo_id, contact_id, display_name, phone, contact_type, campaign_id, message, sent_at, status, error, data_request, data_response, send_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [log.owner_zalo_id, log.contact_id, log.display_name || '', this.normalizeVietnamPhone(log.phone || ''), log.contact_type || 'user', log.campaign_id || null, log.message, log.sent_at, log.status, log.error || '', log.data_request || '', log.data_response || '', log.send_type || '']);
        }
        catch (err) {
            Logger_1.default.error(`[DB] saveSendLog: ${err.message}`);
        }
    }
    getSendLog(ownerZaloId, opts = {}) {
        if (!this.initialized)
            return [];
        try {
            let q = `SELECT * FROM crm_send_log WHERE owner_zalo_id=?`;
            const params = [ownerZaloId];
            if (opts.contactId) {
                q += ` AND contact_id=?`;
                params.push(opts.contactId);
            }
            if (opts.campaignId) {
                q += ` AND campaign_id=?`;
                params.push(opts.campaignId);
            }
            q += ` ORDER BY sent_at DESC LIMIT ?`;
            params.push(opts.limit || 100);
            return this.query(q, params);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getSendLog: ${err.message}`);
            return [];
        }
    }
    /** Top N campaigns with detailed stats including replied count */
    getTopCampaignStats(ownerZaloId, limit = 10) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`
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
        }
        catch (err) {
            Logger_1.default.error(`[DB] getTopCampaignStats: ${err.message}`);
            return [];
        }
    }
    /** CRM Contacts — aggregate friends + contacts, dedup */
    getCRMContacts(ownerZaloId, opts = {}) {
        if (!this.initialized)
            return { contacts: [], total: 0 };
        try {
            const { search, isFriendOnly, contactType = 'all', contactTypes, sortBy = 'name', sortDir = 'asc', limit = 50, offset = 0 } = opts;
            let all = [];
            // Determine effective type filter
            // contactTypes (array) takes priority; fallback to legacy contactType
            const effectiveTypes = (contactTypes && contactTypes.length > 0) ? contactTypes : null;
            const legacyType = isFriendOnly ? 'friend' : (contactType || 'all');
            if (!effectiveTypes && legacyType === 'group') {
                // Only group contacts (legacy fast path)
                all = this.query(`SELECT contact_id, COALESCE(alias,'') as alias, COALESCE(display_name,'') as display_name,
                        COALESCE(avatar_url,'') as avatar, '' as phone,
                        0 as is_friend, COALESCE(last_message_time,0) as last_message_time, 'group' as contact_type,
                        gender, birthday
                     FROM contacts WHERE owner_zalo_id=? AND contact_type='group'
                     AND contact_id IS NOT NULL AND contact_id != ''`, [ownerZaloId]);
            }
            else if (!effectiveTypes && legacyType === 'friend') {
                // Only friends (legacy fast path)
                all = this.query(`SELECT f.user_id as contact_id, COALESCE(c.alias,'') as alias,
                        COALESCE(c.display_name, f.display_name,'') as display_name,
                        COALESCE(c.avatar_url, f.avatar,'') as avatar,
                        COALESCE(c.phone, f.phone,'') as phone,
                        1 as is_friend,
                        COALESCE(c.last_message_time, 0) as last_message_time, 'user' as contact_type,
                        c.gender, c.birthday
                     FROM friends f
                     LEFT JOIN contacts c ON c.owner_zalo_id=f.owner_zalo_id AND c.contact_id=f.user_id
                     WHERE f.owner_zalo_id=?`, [ownerZaloId]);
            }
            else {
                // Build full list: friends + non-friend contacts (including groups)
                const friends = this.query(`SELECT f.user_id as contact_id, COALESCE(c.alias,'') as alias,
                        COALESCE(c.display_name, f.display_name,'') as display_name,
                        COALESCE(c.avatar_url, f.avatar,'') as avatar,
                        COALESCE(c.phone, f.phone,'') as phone,
                        1 as is_friend,
                        COALESCE(c.last_message_time, 0) as last_message_time, 'user' as contact_type,
                        c.gender, c.birthday
                     FROM friends f
                     LEFT JOIN contacts c ON c.owner_zalo_id=f.owner_zalo_id AND c.contact_id=f.user_id
                     WHERE f.owner_zalo_id=?`, [ownerZaloId]);
                const friendIds = new Set(friends.map((f) => f.contact_id));
                const otherContacts = this.query(`SELECT contact_id, COALESCE(alias,'') as alias, COALESCE(display_name,'') as display_name,
                        COALESCE(avatar_url,'') as avatar, COALESCE(phone,'') as phone,
                        is_friend, COALESCE(last_message_time,0) as last_message_time,
                        COALESCE(contact_type,'user') as contact_type,
                        gender, birthday
                     FROM contacts WHERE owner_zalo_id=?
                     AND contact_id IS NOT NULL AND contact_id != ''`, [ownerZaloId]).filter((c) => !friendIds.has(c.contact_id));
                all = [...friends, ...otherContacts];
                // Apply multi-type filter when provided
                if (effectiveTypes && effectiveTypes.length < 3) {
                    all = all.filter((c) => {
                        const isFriendContact = c.is_friend === 1;
                        const isGroup = c.contact_type === 'group';
                        const isNonFriend = !isFriendContact && !isGroup;
                        return ((effectiveTypes.includes('friend') && isFriendContact) ||
                            (effectiveTypes.includes('group') && isGroup) ||
                            (effectiveTypes.includes('non_friend') && isNonFriend));
                    });
                }
                else if (!effectiveTypes && legacyType === 'non_friend') {
                    // Legacy non_friend single type
                    all = all.filter((c) => c.is_friend !== 1 && c.contact_type !== 'group');
                }
            }
            // Apply search filter
            if (search?.trim()) {
                const q = search.toLowerCase();
                all = all.filter(c => (c.display_name || '').toLowerCase().includes(q) ||
                    (c.alias || '').toLowerCase().includes(q) ||
                    (c.phone || '').toLowerCase().includes(q) ||
                    c.contact_id.toLowerCase().includes(q));
            }
            // Sort
            all.sort((a, b) => {
                let va, vb;
                if (sortBy === 'last_message') {
                    va = a.last_message_time;
                    vb = b.last_message_time;
                }
                else {
                    va = (a.alias || a.display_name || '').toLowerCase();
                    vb = (b.alias || b.display_name || '').toLowerCase();
                }
                if (va < vb)
                    return sortDir === 'asc' ? -1 : 1;
                if (va > vb)
                    return sortDir === 'asc' ? 1 : -1;
                return 0;
            });
            const total = all.length;
            // Paginate + note counts
            const page = all.slice(offset, offset + limit);
            const pageIds = page.map((c) => c.contact_id);
            const noteCountMap = {};
            if (pageIds.length > 0) {
                const placeholders = pageIds.map(() => '?').join(',');
                this.query(`SELECT contact_id, COUNT(*) as n FROM crm_notes WHERE owner_zalo_id=? AND contact_id IN (${placeholders}) GROUP BY contact_id`, [ownerZaloId, ...pageIds]).forEach((r) => { noteCountMap[r.contact_id] = r.n; });
            }
            const contacts = page.map((c) => ({
                ...c,
                note_count: noteCountMap[c.contact_id] || 0,
            }));
            return { contacts, total };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getCRMContacts: ${err.message}`);
            return { contacts: [], total: 0 };
        }
    }
    /** Activity stats for a given time window — used by CRM Dashboard */
    getActivityStats(ownerZaloId, sinceTs, untilTs = Date.now()) {
        if (!this.initialized)
            return { conversationCount: 0, messageCount: 0, sentCount: 0, receivedCount: 0 };
        try {
            const row = this.queryOne(`SELECT COUNT(DISTINCT thread_id) as conv_cnt,
                        COUNT(*) as msg_cnt,
                        COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END), 0) as sent_cnt
                 FROM messages
                 WHERE owner_zalo_id=? AND timestamp >= ? AND timestamp <= ?`, [ownerZaloId, sinceTs, untilTs]);
            const conversationCount = row?.conv_cnt || 0;
            const messageCount = row?.msg_cnt || 0;
            const sentCount = row?.sent_cnt || 0;
            return { conversationCount, messageCount, sentCount, receivedCount: messageCount - sentCount };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getActivityStats: ${err.message}`);
            return { conversationCount: 0, messageCount: 0, sentCount: 0, receivedCount: 0 };
        }
    }
    /** Unfiltered aggregate stats — used by CRM Dashboard */
    getContactStats(ownerZaloId) {
        if (!this.initialized)
            return { total: 0, friendCount: 0, noteCount: 0 };
        try {
            const friendCount = this.query(`SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id=?`, [ownerZaloId])[0]?.cnt || 0;
            const nonFriendCount = this.query(`SELECT COUNT(*) as cnt FROM contacts
                 WHERE owner_zalo_id=? AND contact_type != 'group'
                 AND contact_id IS NOT NULL AND contact_id != ''
                 AND contact_id NOT IN (SELECT user_id FROM friends WHERE owner_zalo_id=?)`, [ownerZaloId, ownerZaloId])[0]?.cnt || 0;
            const noteCount = this.query(`SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_notes WHERE owner_zalo_id=?`, [ownerZaloId])[0]?.cnt || 0;
            return { total: friendCount + nonFriendCount, friendCount, noteCount };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getContactStats: ${err.message}`);
            return { total: 0, friendCount: 0, noteCount: 0 };
        }
    }
    // ─── Analytics / Reporting ────────────────────────────────────────────────
    /**
     * Per-account overview: tổng tin nhắn, contacts, groups cho 1 account
     */
    getDashboardOverview(zaloId) {
        const empty = { totalMessages: 0, totalSent: 0, totalReceived: 0, totalContacts: 0, totalFriends: 0, totalGroups: 0, todayMessages: 0, todaySent: 0, todayReceived: 0, yesterdayMessages: 0, activeCampaigns: 0, totalCampaigns: 0 };
        if (!this.initialized || !zaloId)
            return empty;
        try {
            // Today range
            const now = new Date();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
            const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
            const yesterdayStart = todayStart - 86400000;
            const yesterdayEnd = todayStart - 1;
            const msgRow = this.queryOne(`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent FROM messages WHERE owner_zalo_id = ?`, [zaloId]);
            const todayRow = this.queryOne(`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent FROM messages WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?`, [zaloId, todayStart, todayEnd]);
            const yestRow = this.queryOne(`SELECT COUNT(*) as total FROM messages WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?`, [zaloId, yesterdayStart, yesterdayEnd]);
            const contactRow = this.queryOne(`SELECT COUNT(*) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type != 'group'`, [zaloId]);
            const friendRow = this.queryOne(`SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id = ?`, [zaloId]);
            const groupRow = this.queryOne(`SELECT COUNT(DISTINCT contact_id) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type = 'group'`, [zaloId]);
            const campRow = this.queryOne(`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) as active FROM crm_campaigns WHERE owner_zalo_id = ?`, [zaloId]);
            return {
                totalMessages: msgRow?.total || 0,
                totalSent: msgRow?.sent || 0,
                totalReceived: (msgRow?.total || 0) - (msgRow?.sent || 0),
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
        }
        catch (err) {
            Logger_1.default.error(`[DB] getDashboardOverview: ${err.message}`);
            return empty;
        }
    }
    /**
     * Message volume timeline: messages per hour or per day
     * granularity: 'hour' (24 data points for a day) or 'day' (N data points for a range)
     */
    getMessageVolume(zaloId, sinceTs, untilTs, granularity, threadType) {
        if (!this.initialized || !zaloId)
            return [];
        try {
            const threadFilter = threadType !== undefined && threadType !== -1 ? ' AND thread_type = ?' : '';
            const threadParams = threadType !== undefined && threadType !== -1 ? [threadType] : [];
            let sql;
            if (granularity === 'hour') {
                sql = `SELECT
                    CAST((timestamp - ?) / 3600000 AS INTEGER) as hour_idx,
                    COUNT(*) as total,
                    COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent
                FROM messages
                WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}
                GROUP BY hour_idx
                ORDER BY hour_idx`;
                const rows = this.query(sql, [sinceTs, zaloId, sinceTs, untilTs, ...threadParams]);
                const totalHours = Math.min(24, Math.ceil((untilTs - sinceTs) / 3600000));
                const result = [];
                const rowMap = new Map(rows.map((r) => [r.hour_idx, r]));
                for (let i = 0; i < totalHours; i++) {
                    const d = new Date(sinceTs + i * 3600000);
                    const label = `${d.getHours().toString().padStart(2, '0')}:00`;
                    const r = rowMap.get(i);
                    const total = r?.total || 0;
                    const sent = r?.sent || 0;
                    result.push({ bucket: label, sent, received: total - sent, total });
                }
                return result;
            }
            else {
                sql = `SELECT
                    CAST((timestamp - ?) / 86400000 AS INTEGER) as day_idx,
                    COUNT(*) as total,
                    COALESCE(SUM(CASE WHEN is_sent=1 THEN 1 ELSE 0 END),0) as sent
                FROM messages
                WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}
                GROUP BY day_idx
                ORDER BY day_idx`;
                const rows = this.query(sql, [sinceTs, zaloId, sinceTs, untilTs, ...threadParams]);
                const totalDays = Math.ceil((untilTs - sinceTs) / 86400000) + 1;
                const result = [];
                const rowMap = new Map(rows.map((r) => [r.day_idx, r]));
                for (let i = 0; i < totalDays; i++) {
                    const d = new Date(sinceTs + i * 86400000);
                    const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                    const r = rowMap.get(i);
                    const total = r?.total || 0;
                    const sent = r?.sent || 0;
                    result.push({ bucket: label, sent, received: total - sent, total });
                }
                return result;
            }
        }
        catch (err) {
            Logger_1.default.error(`[DB] getMessageVolume: ${err.message}`);
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
     */
    getResponseTimeStats(zaloId, sinceTs, untilTs, threadType) {
        const empty = { avgSeconds: 0, medianSeconds: 0, minSeconds: 0, maxSeconds: 0, totalConversations: 0, totalReplies: 0, distribution: [], byHour: [] };
        if (!this.initialized || !zaloId)
            return empty;
        try {
            // Determine thread_type filter: default to 0 (1-to-1) unless explicitly set
            const ttFilter = threadType !== undefined && threadType !== -1 ? threadType : 0;
            // Get messages in the date range, ordered by thread + time
            const msgs = this.query(`SELECT thread_id, is_sent, timestamp
                 FROM messages
                 WHERE owner_zalo_id = ? AND thread_type = ? AND timestamp >= ? AND timestamp <= ?
                 ORDER BY thread_id, timestamp ASC`, [zaloId, ttFilter, sinceTs, untilTs]);
            if (msgs.length === 0)
                return empty;
            // Group by thread and find response gaps
            const gaps = [];
            const hourGaps = new Map();
            const threadsSeen = new Set();
            let prevThreadId = null;
            let lastIncomingTs = null;
            for (const m of msgs) {
                if (m.thread_id !== prevThreadId) {
                    // New thread
                    prevThreadId = m.thread_id;
                    lastIncomingTs = null;
                }
                if (m.is_sent === 0) {
                    // Incoming message — record timestamp (always take the latest unanswered incoming)
                    lastIncomingTs = m.timestamp;
                }
                else if (m.is_sent === 1 && lastIncomingTs !== null) {
                    // Outgoing message after an incoming one — this is a reply
                    const gapMs = m.timestamp - lastIncomingTs;
                    if (gapMs >= 0 && gapMs < 7 * 86400000) {
                        // Only count replies within 7 days (ignore stale threads)
                        const gapSec = Math.round(gapMs / 1000);
                        gaps.push(gapSec);
                        threadsSeen.add(m.thread_id);
                        // Group by hour of the incoming message
                        const hour = new Date(lastIncomingTs).getHours();
                        if (!hourGaps.has(hour))
                            hourGaps.set(hour, []);
                        hourGaps.get(hour).push(gapSec);
                    }
                    lastIncomingTs = null; // Reset — this reply consumed the incoming
                }
            }
            if (gaps.length === 0)
                return empty;
            // Sort for median/min/max
            gaps.sort((a, b) => a - b);
            const sum = gaps.reduce((s, v) => s + v, 0);
            const avgSeconds = Math.round(sum / gaps.length);
            const medianSeconds = gaps[Math.floor(gaps.length / 2)];
            const minSeconds = gaps[0];
            const maxSeconds = gaps[gaps.length - 1];
            // Distribution buckets
            const bucketDefs = [
                { label: '< 1 phút', maxSec: 60 },
                { label: '1–5 phút', maxSec: 300 },
                { label: '5–15 phút', maxSec: 900 },
                { label: '15–30 phút', maxSec: 1800 },
                { label: '30–60 phút', maxSec: 3600 },
                { label: '1–2 giờ', maxSec: 7200 },
                { label: '2–4 giờ', maxSec: 14400 },
                { label: '4–12 giờ', maxSec: 43200 },
                { label: '12–24 giờ', maxSec: 86400 },
                { label: '> 24 giờ', maxSec: Infinity },
            ];
            const distribution = bucketDefs.map(b => ({ bucket: b.label, count: 0 }));
            for (const g of gaps) {
                for (let i = 0; i < bucketDefs.length; i++) {
                    if (g < bucketDefs[i].maxSec || i === bucketDefs.length - 1) {
                        distribution[i].count++;
                        break;
                    }
                }
            }
            // By hour of day
            const byHour = [];
            for (let h = 0; h < 24; h++) {
                const hGaps = hourGaps.get(h) || [];
                byHour.push({
                    hour: h,
                    avgSeconds: hGaps.length > 0 ? Math.round(hGaps.reduce((s, v) => s + v, 0) / hGaps.length) : 0,
                    count: hGaps.length,
                });
            }
            return {
                avgSeconds,
                medianSeconds,
                minSeconds,
                maxSeconds,
                totalConversations: threadsSeen.size,
                totalReplies: gaps.length,
                distribution,
                byHour,
            };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getResponseTimeStats: ${err.message}`);
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
    getLabelUsageAnalytics(zaloId, sinceTs, untilTs) {
        const empty = { totalAssignments: 0, totalLabelsUsed: 0, avgPerDay: 0, timeline: [], byLabel: [], recentAssignments: [] };
        if (!this.initialized || !zaloId)
            return empty;
        try {
            // Total assignments in period
            const totalRow = this.queryOne(`SELECT COUNT(*) as cnt FROM local_label_threads WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?`, [zaloId, sinceTs, untilTs]);
            const totalAssignments = totalRow?.cnt || 0;
            if (totalAssignments === 0)
                return empty;
            // Distinct labels used
            const labelsUsedRow = this.queryOne(`SELECT COUNT(DISTINCT label_id) as cnt FROM local_label_threads WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?`, [zaloId, sinceTs, untilTs]);
            const totalLabelsUsed = labelsUsedRow?.cnt || 0;
            // Avg per day
            const days = Math.max(1, Math.ceil((untilTs - sinceTs) / 86400000));
            const avgPerDay = Math.round((totalAssignments / days) * 10) / 10;
            // Timeline: assignments per day
            const timelineRows = this.query(`SELECT CAST((created_at - ?) / 86400000 AS INTEGER) as day_idx, COUNT(*) as cnt
                 FROM local_label_threads
                 WHERE owner_zalo_id = ? AND created_at >= ? AND created_at <= ?
                 GROUP BY day_idx
                 ORDER BY day_idx`, [sinceTs, zaloId, sinceTs, untilTs]);
            const timelineMap = new Map(timelineRows.map((r) => [r.day_idx, r.cnt]));
            const timeline = [];
            for (let i = 0; i < days; i++) {
                const d = new Date(sinceTs + i * 86400000);
                const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                timeline.push({ bucket: label, count: timelineMap.get(i) || 0 });
            }
            // By label breakdown
            const byLabel = this.query(`SELECT llt.label_id, ll.name, ll.emoji, ll.color, COUNT(*) as cnt
                 FROM local_label_threads llt
                 INNER JOIN local_labels ll ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id = ? AND llt.created_at >= ? AND llt.created_at <= ?
                 GROUP BY llt.label_id
                 ORDER BY cnt DESC`, [zaloId, sinceTs, untilTs]).map((r) => ({
                labelId: r.label_id,
                name: r.name || 'Không tên',
                emoji: r.emoji || '🏷️',
                color: r.color || '#3B82F6',
                count: r.cnt,
            }));
            // Recent assignments (last 50)
            const recentAssignments = this.query(`SELECT ll.name as label_name, ll.emoji, ll.color, llt.thread_id, llt.created_at
                 FROM local_label_threads llt
                 INNER JOIN local_labels ll ON ll.id = llt.label_id
                 WHERE llt.owner_zalo_id = ? AND llt.created_at >= ? AND llt.created_at <= ?
                 ORDER BY llt.created_at DESC
                 LIMIT 50`, [zaloId, sinceTs, untilTs]).map((r) => ({
                labelName: r.label_name || 'Không tên',
                emoji: r.emoji || '🏷️',
                color: r.color || '#3B82F6',
                threadId: r.thread_id,
                createdAt: r.created_at,
            }));
            return { totalAssignments, totalLabelsUsed, avgPerDay, timeline, byLabel, recentAssignments };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getLabelUsageAnalytics: ${err.message}`);
            return empty;
        }
    }
    /**
     * Peak Hours Heatmap: 7 days × 24 hours grid of message counts
     * Returns array of { dayOfWeek: 0-6 (Mon-Sun), hour: 0-23, count: number }
     */
    getPeakHoursHeatmap(zaloId, sinceTs, untilTs, threadType) {
        if (!this.initialized || !zaloId)
            return [];
        try {
            const threadFilter = threadType !== undefined && threadType !== -1 ? ' AND thread_type = ?' : '';
            const threadParams = threadType !== undefined && threadType !== -1 ? [threadType] : [];
            const rows = this.query(`SELECT timestamp FROM messages WHERE owner_zalo_id = ? AND timestamp >= ? AND timestamp <= ?${threadFilter}`, [zaloId, sinceTs, untilTs, ...threadParams]);
            // Build 7×24 grid
            const grid = new Map();
            for (const r of rows) {
                const d = new Date(r.timestamp);
                const dow = d.getDay(); // 0=Sun, 1=Mon, ...6=Sat
                // Convert to Mon=0 ... Sun=6
                const dowMon = dow === 0 ? 6 : dow - 1;
                const hour = d.getHours();
                const key = `${dowMon}_${hour}`;
                grid.set(key, (grid.get(key) || 0) + 1);
            }
            const result = [];
            for (let d = 0; d < 7; d++) {
                for (let h = 0; h < 24; h++) {
                    result.push({ dayOfWeek: d, hour: h, count: grid.get(`${d}_${h}`) || 0 });
                }
            }
            return result;
        }
        catch (err) {
            Logger_1.default.error(`[DB] getPeakHoursHeatmap: ${err.message}`);
            return [];
        }
    }
    /**
     * Contact growth: new contacts appearing over time (by first message date)
     * Returns array of { bucket: 'dd/MM', newContacts: number, newFriends: number }
     */
    getContactGrowth(zaloId, sinceTs, untilTs) {
        if (!this.initialized || !zaloId)
            return [];
        try {
            const rows = this.query(`SELECT thread_id, owner_zalo_id, MIN(timestamp) as first_ts
                 FROM messages
                 WHERE owner_zalo_id = ? AND thread_type = 0 AND timestamp >= ? AND timestamp <= ?
                 GROUP BY owner_zalo_id, thread_id
                 HAVING first_ts >= ? AND first_ts <= ?`, [zaloId, sinceTs, untilTs, sinceTs, untilTs]);
            const friendSet = new Set();
            const friendRows = this.query(`SELECT owner_zalo_id, user_id FROM friends WHERE owner_zalo_id = ?`, [zaloId]);
            for (const f of friendRows)
                friendSet.add(`${f.owner_zalo_id}_${f.user_id}`);
            const totalDays = Math.ceil((untilTs - sinceTs) / 86400000) + 1;
            const buckets = [];
            const dayMap = new Map();
            for (const r of rows) {
                const dayIdx = Math.floor((r.first_ts - sinceTs) / 86400000);
                const entry = dayMap.get(dayIdx) || { contacts: 0, friends: 0 };
                entry.contacts++;
                if (friendSet.has(`${r.owner_zalo_id}_${r.thread_id}`))
                    entry.friends++;
                dayMap.set(dayIdx, entry);
            }
            for (let i = 0; i < totalDays; i++) {
                const d = new Date(sinceTs + i * 86400000);
                const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                const entry = dayMap.get(i) || { contacts: 0, friends: 0 };
                buckets.push({ bucket: label, newContacts: entry.contacts, newFriends: entry.friends });
            }
            return buckets;
        }
        catch (err) {
            Logger_1.default.error(`[DB] getContactGrowth: ${err.message}`);
            return [];
        }
    }
    /**
     * Contact segmentation: phân bổ contacts theo type, friend status, tag, note
     */
    getContactSegmentation(zaloId) {
        const empty = { byType: [], tagged: 0, untagged: 0, withNotes: 0, withoutNotes: 0 };
        if (!this.initialized || !zaloId)
            return empty;
        try {
            const friendCount = this.queryOne(`SELECT COUNT(*) as cnt FROM friends WHERE owner_zalo_id = ?`, [zaloId])?.cnt || 0;
            const nonFriendCount = this.queryOne(`SELECT COUNT(*) as cnt FROM contacts
                 WHERE owner_zalo_id = ? AND contact_type != 'group'
                 AND contact_id NOT IN (SELECT user_id FROM friends WHERE owner_zalo_id = ?)`, [zaloId, zaloId])?.cnt || 0;
            const groupCount = this.queryOne(`SELECT COUNT(DISTINCT contact_id) as cnt FROM contacts WHERE owner_zalo_id = ? AND contact_type = 'group'`, [zaloId])?.cnt || 0;
            const byType = [
                { type: 'Bạn bè', count: friendCount },
                { type: 'Người lạ', count: nonFriendCount },
                { type: 'Nhóm', count: groupCount },
            ];
            // Tagged vs untagged (CRM tags + local labels)
            const taggedContacts = this.queryOne(`SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_contact_tags WHERE owner_zalo_id = ?`, [zaloId])?.cnt || 0;
            const labeledThreads = this.queryOne(`SELECT COUNT(DISTINCT thread_id) as cnt FROM local_label_threads WHERE owner_zalo_id = ?`, [zaloId])?.cnt || 0;
            const tagged = taggedContacts + labeledThreads;
            const totalContacts = friendCount + nonFriendCount;
            const untagged = Math.max(0, totalContacts - tagged);
            // With notes vs without
            const withNotes = this.queryOne(`SELECT COUNT(DISTINCT contact_id) as cnt FROM crm_notes WHERE owner_zalo_id = ?`, [zaloId])?.cnt || 0;
            const withoutNotes = Math.max(0, totalContacts - withNotes);
            return { byType, tagged, untagged, withNotes, withoutNotes };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getContactSegmentation: ${err.message}`);
            return empty;
        }
    }
    /**
     * Campaign comparison: all campaigns with detailed metrics
     */
    getCampaignComparison(zaloId) {
        if (!this.initialized || !zaloId)
            return [];
        try {
            const rows = this.query(`
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
            return rows.map((r) => {
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
        }
        catch (err) {
            Logger_1.default.error(`[DB] getCampaignComparison: ${err.message}`);
            return [];
        }
    }
    /**
     * Friend request analytics: sent/received/accepted over time
     */
    getFriendRequestAnalytics(zaloId, sinceTs, untilTs) {
        const empty = { totalSent: 0, totalReceived: 0, timeline: [] };
        if (!this.initialized || !zaloId)
            return empty;
        try {
            const sentCount = this.queryOne(`SELECT COUNT(*) as cnt FROM friend_requests WHERE owner_zalo_id = ? AND direction='sent' AND created_at >= ? AND created_at <= ?`, [zaloId, sinceTs, untilTs])?.cnt || 0;
            const receivedCount = this.queryOne(`SELECT COUNT(*) as cnt FROM friend_requests WHERE owner_zalo_id = ? AND direction='received' AND created_at >= ? AND created_at <= ?`, [zaloId, sinceTs, untilTs])?.cnt || 0;
            const totalDays = Math.ceil((untilTs - sinceTs) / 86400000) + 1;
            const sentRows = this.query(`SELECT CAST((created_at - ?) / 86400000 AS INTEGER) as day_idx, COUNT(*) as cnt
                 FROM friend_requests WHERE owner_zalo_id = ? AND direction='sent' AND created_at >= ? AND created_at <= ?
                 GROUP BY day_idx`, [sinceTs, zaloId, sinceTs, untilTs]);
            const recvRows = this.query(`SELECT CAST((created_at - ?) / 86400000 AS INTEGER) as day_idx, COUNT(*) as cnt
                 FROM friend_requests WHERE owner_zalo_id = ? AND direction='received' AND created_at >= ? AND created_at <= ?
                 GROUP BY day_idx`, [sinceTs, zaloId, sinceTs, untilTs]);
            const sentMap = new Map(sentRows.map((r) => [r.day_idx, r.cnt]));
            const recvMap = new Map(recvRows.map((r) => [r.day_idx, r.cnt]));
            const timeline = [];
            for (let i = 0; i < totalDays; i++) {
                const d = new Date(sinceTs + i * 86400000);
                const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                timeline.push({ bucket: label, sent: sentMap.get(i) || 0, received: recvMap.get(i) || 0 });
            }
            return { totalSent: sentCount, totalReceived: receivedCount, timeline };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getFriendRequestAnalytics: ${err.message}`);
            return empty;
        }
    }
    // ─── Workflow Analytics ─────────────────────────────────────────────────
    /**
     * Workflow analytics for a specific account: run counts, success/error rate, top workflows
     */
    getWorkflowAnalytics(zaloId, sinceTs, untilTs) {
        const empty = { totalRuns: 0, successRuns: 0, errorRuns: 0, successRate: 0, avgDuration: 0, topWorkflows: [], timeline: [] };
        if (!this.initialized || !zaloId)
            return empty;
        try {
            // Get workflows that belong to this account
            const allWfs = this.query(`SELECT id, name, page_ids FROM workflows`);
            const accountWfIds = allWfs
                .filter((w) => (w.page_ids || '').split(',').filter(Boolean).includes(zaloId))
                .map((w) => w.id);
            if (accountWfIds.length === 0)
                return empty;
            const ph = accountWfIds.map(() => '?').join(',');
            // Overall stats
            const statsRow = this.queryOne(`SELECT COUNT(*) as total,
                    COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) as success_cnt,
                    COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) as error_cnt,
                    COALESCE(AVG(CASE WHEN finished_at > 0 AND started_at > 0 THEN finished_at - started_at END),0) as avg_dur
                 FROM workflow_run_logs
                 WHERE workflow_id IN (${ph}) AND started_at >= ? AND started_at <= ?`, [...accountWfIds, sinceTs, untilTs]);
            const totalRuns = statsRow?.total || 0;
            const successRuns = statsRow?.success_cnt || 0;
            const errorRuns = statsRow?.error_cnt || 0;
            // Top workflows
            const topRows = this.query(`SELECT workflow_name, COUNT(*) as runs,
                    COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) as success_cnt
                 FROM workflow_run_logs
                 WHERE workflow_id IN (${ph}) AND started_at >= ? AND started_at <= ?
                 GROUP BY workflow_id
                 ORDER BY runs DESC LIMIT 10`, [...accountWfIds, sinceTs, untilTs]);
            const topWorkflows = topRows.map((r) => ({
                workflowName: r.workflow_name,
                runs: r.runs,
                successRate: r.runs > 0 ? Math.round(r.success_cnt / r.runs * 100) : 0,
            }));
            // Timeline by day
            const totalDays = Math.ceil((untilTs - sinceTs) / 86400000) + 1;
            const tlRows = this.query(`SELECT CAST((started_at - ?) / 86400000 AS INTEGER) as day_idx,
                    COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) as s,
                    COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) as e
                 FROM workflow_run_logs
                 WHERE workflow_id IN (${ph}) AND started_at >= ? AND started_at <= ?
                 GROUP BY day_idx ORDER BY day_idx`, [sinceTs, ...accountWfIds, sinceTs, untilTs]);
            const tlMap = new Map(tlRows.map((r) => [r.day_idx, r]));
            const timeline = [];
            for (let i = 0; i < totalDays; i++) {
                const d = new Date(sinceTs + i * 86400000);
                const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                const r = tlMap.get(i);
                timeline.push({ bucket: label, success: r?.s || 0, error: r?.e || 0 });
            }
            return {
                totalRuns, successRuns, errorRuns,
                successRate: totalRuns > 0 ? Math.round(successRuns / totalRuns * 100) : 0,
                avgDuration: Math.round(statsRow?.avg_dur || 0),
                topWorkflows,
                timeline,
            };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getWorkflowAnalytics: ${err.message}`);
            return empty;
        }
    }
    // ─── AI Analytics ─────────────────────────────────────────────────────
    /**
     * AI usage analytics: tokens consumed, request counts, model breakdown
     */
    getAIAnalytics(sinceTs, untilTs) {
        const empty = { totalRequests: 0, totalTokens: 0, totalPromptTokens: 0, totalCompletionTokens: 0, byModel: [], byAssistant: [], timeline: [] };
        if (!this.initialized)
            return empty;
        try {
            // Overall stats
            const statsRow = this.queryOne(`SELECT COUNT(*) as total,
                    COALESCE(SUM(total_tokens),0) as tokens,
                    COALESCE(SUM(prompt_tokens),0) as prompt_tokens,
                    COALESCE(SUM(completion_tokens),0) as completion_tokens
                 FROM ai_usage_logs WHERE created_at >= ? AND created_at <= ?`, [sinceTs, untilTs]);
            // By model
            const modelRows = this.query(`SELECT model, COUNT(*) as requests, COALESCE(SUM(total_tokens),0) as tokens
                 FROM ai_usage_logs WHERE created_at >= ? AND created_at <= ?
                 GROUP BY model ORDER BY tokens DESC`, [sinceTs, untilTs]);
            // By assistant
            const assistantRows = this.query(`SELECT assistant_name, COUNT(*) as requests, COALESCE(SUM(total_tokens),0) as tokens
                 FROM ai_usage_logs WHERE created_at >= ? AND created_at <= ?
                 GROUP BY assistant_id ORDER BY tokens DESC`, [sinceTs, untilTs]);
            // Timeline by day
            const totalDays = Math.ceil((untilTs - sinceTs) / 86400000) + 1;
            const tlRows = this.query(`SELECT CAST((created_at - ?) / 86400000 AS INTEGER) as day_idx,
                    COUNT(*) as requests, COALESCE(SUM(total_tokens),0) as tokens
                 FROM ai_usage_logs WHERE created_at >= ? AND created_at <= ?
                 GROUP BY day_idx ORDER BY day_idx`, [sinceTs, sinceTs, untilTs]);
            const tlMap = new Map(tlRows.map((r) => [r.day_idx, r]));
            const timeline = [];
            for (let i = 0; i < totalDays; i++) {
                const d = new Date(sinceTs + i * 86400000);
                const label = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
                const r = tlMap.get(i);
                timeline.push({ bucket: label, requests: r?.requests || 0, tokens: r?.tokens || 0 });
            }
            return {
                totalRequests: statsRow?.total || 0,
                totalTokens: statsRow?.tokens || 0,
                totalPromptTokens: statsRow?.prompt_tokens || 0,
                totalCompletionTokens: statsRow?.completion_tokens || 0,
                byModel: modelRows.map((r) => ({ model: r.model || 'unknown', requests: r.requests, tokens: r.tokens })),
                byAssistant: assistantRows.map((r) => ({ assistantName: r.assistant_name || 'unknown', requests: r.requests, tokens: r.tokens })),
                timeline,
            };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getAIAnalytics: ${err.message}`);
            return empty;
        }
    }
    // ─── Workflow Engine ──────────────────────────────────────────────────────
    getWorkflows() {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM workflows ORDER BY updated_at DESC`).map(r => ({
                ...r,
                channel: this.normalizeWorkflowChannel(r.channel),
                // Normalise: prefer page_ids, fall back to page_id for old rows
                page_ids: r.page_ids && r.page_ids.trim()
                    ? r.page_ids
                    : (r.page_id && r.page_id.trim() ? r.page_id : ''),
            }));
        }
        catch (err) {
            Logger_1.default.error(`[DB] getWorkflows: ${err.message}`);
            return [];
        }
    }
    getWorkflowById(id) {
        if (!this.initialized)
            return null;
        try {
            const r = this.queryOne(`SELECT * FROM workflows WHERE id=?`, [id]);
            if (!r)
                return null;
            return {
                ...r,
                channel: this.normalizeWorkflowChannel(r.channel),
                page_ids: r.page_ids && r.page_ids.trim()
                    ? r.page_ids
                    : (r.page_id && r.page_id.trim() ? r.page_id : ''),
            };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getWorkflowById: ${err.message}`);
            return null;
        }
    }
    saveWorkflow(wf) {
        if (!this.initialized)
            return;
        try {
            // pageIds: array → comma-separated string
            const pageIds = Array.isArray(wf.pageIds)
                ? wf.pageIds.filter(Boolean).join(',')
                : (wf.pageId || '');
            const channel = this.normalizeWorkflowChannel(wf.channel);
            this.run(`INSERT OR REPLACE INTO workflows
                 (id, name, description, enabled, channel, page_id, page_ids, nodes_json, edges_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                wf.id, wf.name, wf.description || '', wf.enabled ? 1 : 0,
                channel,
                pageIds, // keep page_id in sync with first page for legacy compat
                pageIds,
                JSON.stringify(wf.nodes || []), JSON.stringify(wf.edges || []),
                wf.createdAt || Date.now(), wf.updatedAt || Date.now(),
            ]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] saveWorkflow: ${err.message}`);
        }
    }
    deleteWorkflow(id) {
        if (!this.initialized)
            return;
        try {
            this.runNoSave(`DELETE FROM workflows WHERE id=?`, [id]);
            this.runNoSave(`DELETE FROM workflow_run_logs WHERE workflow_id=?`, [id]);
            this.save();
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteWorkflow: ${err.message}`);
        }
    }
    toggleWorkflow(id, enabled) {
        if (!this.initialized)
            return;
        try {
            this.run(`UPDATE workflows SET enabled=?, updated_at=? WHERE id=?`, [enabled ? 1 : 0, Date.now(), id]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] toggleWorkflow: ${err.message}`);
        }
    }
    /**
     * Clone một workflow sang page đích.
     * Tạo bản sao mới (uuid mới) với pageIds = [targetZaloId], enabled = false.
     */
    cloneWorkflow(sourceId, targetZaloId) {
        if (!this.initialized)
            return null;
        try {
            const source = this.getWorkflowById(sourceId);
            if (!source)
                return null;
            const { v4: uuidv4 } = require('uuid');
            const newId = uuidv4();
            const now = Date.now();
            const channel = this.normalizeWorkflowChannel(source.channel);
            this.run(`INSERT INTO workflows
                 (id, name, description, enabled, channel, page_id, page_ids, nodes_json, edges_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                newId,
                `${source.name} (copy)`,
                source.description || '',
                0, // disabled by default
                channel,
                targetZaloId,
                targetZaloId,
                source.nodes_json,
                source.edges_json,
                now, now,
            ]);
            return newId;
        }
        catch (err) {
            Logger_1.default.error(`[DB] cloneWorkflow: ${err.message}`);
            return null;
        }
    }
    /**
     * Clone toàn bộ workflows thuộc sourceZaloId sang targetZaloId.
     * Trả về số lượng workflows đã clone.
     */
    cloneAllWorkflows(sourceZaloId, targetZaloId) {
        if (!this.initialized)
            return 0;
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
                if (cloned)
                    count++;
            }
            return count;
        }
        catch (err) {
            Logger_1.default.error(`[DB] cloneAllWorkflows: ${err.message}`);
            return 0;
        }
    }
    saveWorkflowRunLog(log) {
        if (!this.initialized)
            return;
        try {
            this.run(`INSERT OR REPLACE INTO workflow_run_logs (id, workflow_id, workflow_name, triggered_by, started_at, finished_at, status, error_message, node_results)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                log.id, log.workflowId, log.workflowName, log.triggeredBy,
                log.startedAt, log.finishedAt, log.status, log.errorMessage || null,
                JSON.stringify(log.nodeResults || []),
            ]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] saveWorkflowRunLog: ${err.message}`);
        }
    }
    getWorkflowRunLogs(workflowId, limit = 50) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM workflow_run_logs WHERE workflow_id=? ORDER BY started_at DESC LIMIT ?`, [workflowId, limit]).map((r) => ({ ...r, nodeResults: JSON.parse(r.node_results || '[]') }));
        }
        catch (err) {
            Logger_1.default.error(`[DB] getWorkflowRunLogs: ${err.message}`);
            return [];
        }
    }
    getRecentRunLogs(limit = 100) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM workflow_run_logs ORDER BY started_at DESC LIMIT ?`, [limit]).map((r) => ({ ...r, nodeResults: JSON.parse(r.node_results || '[]') }));
        }
        catch (err) {
            Logger_1.default.error(`[DB] getRecentRunLogs: ${err.message}`);
            return [];
        }
    }
    deleteOldRunLogs(olderThanDays = 30) {
        if (!this.initialized)
            return;
        try {
            const cutoff = Date.now() - olderThanDays * 86400000;
            this.run(`DELETE FROM workflow_run_logs WHERE started_at < ?`, [cutoff]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteOldRunLogs: ${err.message}`);
        }
    }
    // ─── Integration Hub Operations ───────────────────────────────────────────
    getIntegrations() {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM integrations ORDER BY created_at ASC`);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getIntegrations: ${err.message}`);
            return [];
        }
    }
    upsertIntegration(row) {
        if (!this.initialized)
            return;
        try {
            this.run(`INSERT INTO integrations (id, type, name, enabled, credentials_encrypted, settings, connected_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   type=excluded.type, name=excluded.name, enabled=excluded.enabled,
                   credentials_encrypted=excluded.credentials_encrypted,
                   settings=excluded.settings, connected_at=excluded.connected_at,
                   updated_at=excluded.updated_at`, [row.id, row.type, row.name, row.enabled, row.credentials_encrypted,
                row.settings, row.connected_at, row.created_at, row.updated_at]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] upsertIntegration: ${err.message}`);
        }
    }
    deleteIntegration(id) {
        if (!this.initialized)
            return;
        try {
            this.run(`DELETE FROM integrations WHERE id = ?`, [id]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteIntegration: ${err.message}`);
        }
    }
    toggleIntegration(id, enabled) {
        if (!this.initialized)
            return;
        try {
            this.run(`UPDATE integrations SET enabled = ?, updated_at = ? WHERE id = ?`, [enabled ? 1 : 0, Date.now(), id]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] toggleIntegration: ${err.message}`);
        }
    }
    markIntegrationConnected(id, connectedAt) {
        if (!this.initialized)
            return;
        try {
            this.run(`UPDATE integrations SET connected_at = ?, updated_at = ? WHERE id = ?`, [connectedAt, Date.now(), id]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] markIntegrationConnected: ${err.message}`);
        }
    }
    // ─── Message Draft Operations ─────────────────────────────────────────
    /** Upsert draft: lưu hoặc cập nhật nội dung draft cho 1 thread */
    upsertDraft(ownerZaloId, threadId, content) {
        if (!this.initialized || !threadId)
            return;
        try {
            this.run(`INSERT INTO message_drafts (owner_zalo_id, thread_id, content, updated_at)
                 VALUES (?,?,?,?)
                 ON CONFLICT(owner_zalo_id, thread_id) DO UPDATE SET
                   content=excluded.content,
                   updated_at=excluded.updated_at`, [ownerZaloId, threadId, content, Date.now()]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] upsertDraft error: ${err.message}`);
        }
    }
    /** Xoá draft cho 1 thread (khi gửi tin nhắn hoặc xoá hết text) */
    deleteDraft(ownerZaloId, threadId) {
        if (!this.initialized || !threadId)
            return;
        try {
            this.run(`DELETE FROM message_drafts WHERE owner_zalo_id = ? AND thread_id = ?`, [ownerZaloId, threadId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteDraft error: ${err.message}`);
        }
    }
    /** Lấy draft cho 1 thread */
    getDraft(ownerZaloId, threadId) {
        if (!this.initialized)
            return null;
        try {
            const row = this.queryOne(`SELECT content, updated_at FROM message_drafts WHERE owner_zalo_id = ? AND thread_id = ?`, [ownerZaloId, threadId]);
            return row ? { content: row.content, updatedAt: row.updated_at } : null;
        }
        catch (err) {
            Logger_1.default.error(`[DB] getDraft error: ${err.message}`);
            return null;
        }
    }
    /** Lấy tất cả drafts cho 1 tài khoản — dùng khi khởi tạo app */
    getDrafts(ownerZaloId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT thread_id, content, updated_at FROM message_drafts WHERE owner_zalo_id = ? ORDER BY updated_at DESC`, [ownerZaloId]).map(r => ({ threadId: r.thread_id, content: r.content, updatedAt: r.updated_at }));
        }
        catch (err) {
            Logger_1.default.error(`[DB] getDrafts error: ${err.message}`);
            return [];
        }
    }
    /** Xoá tất cả draft cũ hơn N ngày — cleanup */
    deleteOldDrafts(olderThanDays = 7) {
        if (!this.initialized)
            return;
        try {
            const cutoff = Date.now() - olderThanDays * 86400000;
            this.run(`DELETE FROM message_drafts WHERE updated_at < ?`, [cutoff]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteOldDrafts error: ${err.message}`);
        }
    }
    // ─── Bank Cards ───────────────────────────────────────────────────────
    /** Lấy danh sách thẻ ngân hàng của tài khoản */
    getBankCards(ownerZaloId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM bank_cards WHERE owner_zalo_id = ? ORDER BY is_default DESC, created_at DESC`, [ownerZaloId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getBankCards error: ${err.message}`);
            return [];
        }
    }
    /** Thêm/sửa thẻ ngân hàng */
    upsertBankCard(ownerZaloId, card) {
        if (!this.initialized)
            return -1;
        try {
            const now = Date.now();
            // Nếu đặt mặc định → bỏ default của các thẻ khác
            if (card.is_default) {
                this.run(`UPDATE bank_cards SET is_default = 0 WHERE owner_zalo_id = ?`, [ownerZaloId]);
            }
            if (card.id) {
                this.run(`UPDATE bank_cards SET bank_name=?, bin_bank=?, account_number=?, account_name=?, is_default=?, updated_at=?
                     WHERE id=? AND owner_zalo_id=?`, [card.bank_name, card.bin_bank, card.account_number, card.account_name, card.is_default ?? 0, now, card.id, ownerZaloId]);
                return card.id;
            }
            else {
                this.run(`INSERT INTO bank_cards (owner_zalo_id, bank_name, bin_bank, account_number, account_name, is_default, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?)`, [ownerZaloId, card.bank_name, card.bin_bank, card.account_number, card.account_name, card.is_default ?? 0, now, now]);
                const row = this.queryOne(`SELECT last_insert_rowid() as id`);
                return row?.id ?? -1;
            }
        }
        catch (err) {
            Logger_1.default.error(`[DB] upsertBankCard error: ${err.message}`);
            return -1;
        }
    }
    /** Xóa thẻ ngân hàng */
    deleteBankCard(ownerZaloId, id) {
        if (!this.initialized)
            return;
        try {
            this.run(`DELETE FROM bank_cards WHERE id = ? AND owner_zalo_id = ?`, [id, ownerZaloId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteBankCard error: ${err.message}`);
        }
    }
    // ─── Local Pinned Conversations ──────────────────────────────────────
    /** Trả về danh sách threadId đang được ghim cục bộ, sắp xếp mới nhất trước. */
    getLocalPinnedConversations(ownerZaloId) {
        if (!this.initialized)
            return [];
        try {
            const rows = this.query(`SELECT thread_id FROM local_pinned_conversations WHERE owner_zalo_id = ? ORDER BY pinned_at DESC`, [ownerZaloId]);
            return rows.map(r => r.thread_id);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getLocalPinnedConversations error: ${err.message}`);
            return [];
        }
    }
    /** Ghim hoặc bỏ ghim một hội thoại cục bộ. */
    setLocalPinnedConversation(ownerZaloId, threadId, isPinned) {
        if (!this.initialized)
            return;
        try {
            if (isPinned) {
                this.run(`INSERT OR REPLACE INTO local_pinned_conversations (owner_zalo_id, thread_id, pinned_at) VALUES (?,?,?)`, [ownerZaloId, threadId, Date.now()]);
            }
            else {
                this.run(`DELETE FROM local_pinned_conversations WHERE owner_zalo_id = ? AND thread_id = ?`, [ownerZaloId, threadId]);
            }
        }
        catch (err) {
            Logger_1.default.error(`[DB] setLocalPinnedConversation error: ${err.message}`);
        }
    }
    // ─── Employee Management ──────────────────────────────────────────────
    getEmployees() {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM employees ORDER BY created_at DESC`);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployees error: ${err.message}`);
            return [];
        }
    }
    getEmployeeById(employeeId) {
        if (!this.initialized)
            return undefined;
        try {
            return this.queryOne(`SELECT * FROM employees WHERE employee_id = ?`, [employeeId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeById error: ${err.message}`);
            return undefined;
        }
    }
    getEmployeeByUsername(username) {
        if (!this.initialized)
            return undefined;
        try {
            return this.queryOne(`SELECT * FROM employees WHERE username = ?`, [username]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeByUsername error: ${err.message}`);
            return undefined;
        }
    }
    createEmployee(employee) {
        if (!this.initialized)
            return 0;
        try {
            const now = Date.now();
            return this.runInsert(`INSERT INTO employees (employee_id, username, password_hash, display_name, avatar_url, role, is_active, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,1,?,?)`, [employee.employee_id, employee.username.toLowerCase().trim(), employee.password_hash, employee.display_name, employee.avatar_url || '', employee.role || 'employee', now, now]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] createEmployee error: ${err.message}`);
            return 0;
        }
    }
    updateEmployee(employeeId, updates) {
        if (!this.initialized)
            return;
        try {
            const sets = [];
            const params = [];
            if (updates.display_name !== undefined) {
                sets.push('display_name = ?');
                params.push(updates.display_name);
            }
            if (updates.avatar_url !== undefined) {
                sets.push('avatar_url = ?');
                params.push(updates.avatar_url);
            }
            if (updates.password_hash !== undefined) {
                sets.push('password_hash = ?');
                params.push(updates.password_hash);
            }
            if (updates.is_active !== undefined) {
                sets.push('is_active = ?');
                params.push(updates.is_active);
            }
            if (updates.role !== undefined) {
                sets.push('role = ?');
                params.push(updates.role);
            }
            if (updates.group_id !== undefined) {
                sets.push('group_id = ?');
                params.push(updates.group_id);
            }
            if (sets.length === 0)
                return;
            sets.push('updated_at = ?');
            params.push(Date.now());
            params.push(employeeId);
            this.run(`UPDATE employees SET ${sets.join(', ')} WHERE employee_id = ?`, params);
        }
        catch (err) {
            Logger_1.default.error(`[DB] updateEmployee error: ${err.message}`);
        }
    }
    deleteEmployee(employeeId) {
        if (!this.initialized)
            return;
        try {
            this.run(`DELETE FROM employee_permissions WHERE employee_id = ?`, [employeeId]);
            this.run(`DELETE FROM employee_account_access WHERE employee_id = ?`, [employeeId]);
            this.run(`DELETE FROM employee_sessions WHERE employee_id = ?`, [employeeId]);
            this.run(`DELETE FROM employees WHERE employee_id = ?`, [employeeId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteEmployee error: ${err.message}`);
        }
    }
    updateEmployeeLastLogin(employeeId) {
        if (!this.initialized)
            return;
        try {
            this.run(`UPDATE employees SET last_login = ? WHERE employee_id = ?`, [Date.now(), employeeId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] updateEmployeeLastLogin error: ${err.message}`);
        }
    }
    // ─── Employee Permissions ──────────────────────────────────────────
    getEmployeePermissions(employeeId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT module, can_access FROM employee_permissions WHERE employee_id = ?`, [employeeId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeePermissions error: ${err.message}`);
            return [];
        }
    }
    setEmployeePermissions(employeeId, permissions) {
        if (!this.initialized)
            return;
        try {
            this.runNoSave(`DELETE FROM employee_permissions WHERE employee_id = ?`, [employeeId]);
            for (const perm of permissions) {
                this.runNoSave(`INSERT INTO employee_permissions (employee_id, module, can_access) VALUES (?,?,?)`, [employeeId, perm.module, perm.can_access ? 1 : 0]);
            }
            this.save();
        }
        catch (err) {
            Logger_1.default.error(`[DB] setEmployeePermissions error: ${err.message}`);
        }
    }
    // ─── Employee Account Access ──────────────────────────────────────
    getEmployeeAccountAccess(employeeId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT zalo_id FROM employee_account_access WHERE employee_id = ?`, [employeeId]).map(r => r.zalo_id);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeAccountAccess error: ${err.message}`);
            return [];
        }
    }
    setEmployeeAccountAccess(employeeId, zaloIds) {
        if (!this.initialized)
            return;
        try {
            this.runNoSave(`DELETE FROM employee_account_access WHERE employee_id = ?`, [employeeId]);
            for (const zaloId of zaloIds) {
                this.runNoSave(`INSERT INTO employee_account_access (employee_id, zalo_id) VALUES (?,?)`, [employeeId, zaloId]);
            }
            this.save();
        }
        catch (err) {
            Logger_1.default.error(`[DB] setEmployeeAccountAccess error: ${err.message}`);
        }
    }
    getEmployeesForAccount(zaloId) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT e.* FROM employees e JOIN employee_account_access ea ON e.employee_id = ea.employee_id WHERE ea.zalo_id = ?`, [zaloId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeesForAccount error: ${err.message}`);
            return [];
        }
    }
    // ─── Employee Message Log ──────────────────────────────────────────
    logEmployeeAction(params) {
        if (!this.initialized)
            return 0;
        try {
            return this.runInsert(`INSERT INTO employee_message_log (employee_id, zalo_id, thread_id, thread_type, msg_id, action, metadata, timestamp)
                 VALUES (?,?,?,?,?,?,?,?)`, [params.employee_id, params.zalo_id, params.thread_id, params.thread_type || 0, params.msg_id || null, params.action, params.metadata || '{}', Date.now()]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] logEmployeeAction error: ${err.message}`);
            return 0;
        }
    }
    /** Start a new employee session (returns session id) */
    startEmployeeSession(employeeId, ipAddress, machineName) {
        if (!this.initialized)
            return 0;
        try {
            return this.runInsert(`INSERT INTO employee_sessions (employee_id, machine_name, ip_address, connected_at) VALUES (?,?,?,?)`, [employeeId, machineName || '', ipAddress || '', Date.now()]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] startEmployeeSession error: ${err.message}`);
            return 0;
        }
    }
    /** End an employee session (set disconnected_at) */
    endEmployeeSession(employeeId) {
        if (!this.initialized)
            return;
        try {
            // Close all open sessions for this employee
            this.run(`UPDATE employee_sessions SET disconnected_at = ? WHERE employee_id = ? AND disconnected_at IS NULL`, [Date.now(), employeeId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] endEmployeeSession error: ${err.message}`);
        }
    }
    getEmployeeStats(employeeId, sinceTs, untilTs) {
        if (!this.initialized)
            return {};
        try {
            const since = sinceTs || 0;
            const until = untilTs || Date.now();
            const sent = this.queryOne(`SELECT COUNT(*) as count FROM employee_message_log WHERE employee_id = ? AND action = 'sent' AND timestamp >= ? AND timestamp <= ?`, [employeeId, since, until]);
            const conversations = this.queryOne(`SELECT COUNT(DISTINCT thread_id) as count FROM employee_message_log WHERE employee_id = ? AND timestamp >= ? AND timestamp <= ?`, [employeeId, since, until]);
            const avgResponse = this.queryOne(`SELECT AVG(CAST(json_extract(metadata, '$.response_time_ms') AS REAL)) as avg_ms
                 FROM employee_message_log WHERE employee_id = ? AND action = 'replied'
                 AND json_extract(metadata, '$.response_time_ms') IS NOT NULL
                 AND timestamp >= ? AND timestamp <= ?`, [employeeId, since, until]);
            // Include sessions that OVERLAP with the [since, until] window
            // (not just sessions that started within the window)
            const sessions = this.query(`SELECT connected_at, disconnected_at FROM employee_sessions
                 WHERE employee_id = ? AND connected_at <= ? AND (disconnected_at >= ? OR disconnected_at IS NULL)`, [employeeId, until, since]);
            let totalOnlineMs = 0;
            for (const s of sessions) {
                const start = Math.max(s.connected_at, since);
                const end = Math.min(s.disconnected_at || Date.now(), until);
                if (end > start)
                    totalOnlineMs += (end - start);
            }
            return {
                messages_sent: sent?.count || 0,
                conversations_handled: conversations?.count || 0,
                avg_response_time_ms: avgResponse?.avg_ms || 0,
                total_online_hours: Math.round((totalOnlineMs / 3600000) * 10) / 10,
            };
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeStats error: ${err.message}`);
            return {};
        }
    }
    getEmployeeSessions(employeeId, limit = 50) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM employee_sessions WHERE employee_id = ? ORDER BY connected_at DESC LIMIT ?`, [employeeId, limit]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeSessions error: ${err.message}`);
            return [];
        }
    }
    // ─── Employee Groups ──────────────────────────────────────────────
    getEmployeeGroups() {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT * FROM employee_groups ORDER BY sort_order ASC, created_at ASC`);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeGroups error: ${err.message}`);
            return [];
        }
    }
    createEmployeeGroup(params) {
        if (!this.initialized)
            return;
        try {
            this.run(`INSERT INTO employee_groups (group_id, name, color, sort_order, created_at) VALUES (?,?,?,?,?)`, [params.group_id, params.name, params.color || '', 0, Date.now()]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] createEmployeeGroup error: ${err.message}`);
        }
    }
    updateEmployeeGroup(groupId, updates) {
        if (!this.initialized)
            return;
        try {
            const sets = [];
            const params = [];
            if (updates.name !== undefined) {
                sets.push('name = ?');
                params.push(updates.name);
            }
            if (updates.color !== undefined) {
                sets.push('color = ?');
                params.push(updates.color);
            }
            if (updates.sort_order !== undefined) {
                sets.push('sort_order = ?');
                params.push(updates.sort_order);
            }
            if (sets.length === 0)
                return;
            params.push(groupId);
            this.run(`UPDATE employee_groups SET ${sets.join(', ')} WHERE group_id = ?`, params);
        }
        catch (err) {
            Logger_1.default.error(`[DB] updateEmployeeGroup error: ${err.message}`);
        }
    }
    deleteEmployeeGroup(groupId) {
        if (!this.initialized)
            return;
        try {
            // Unset group_id for employees in this group
            this.run(`UPDATE employees SET group_id = NULL WHERE group_id = ?`, [groupId]);
            this.run(`DELETE FROM employee_groups WHERE group_id = ?`, [groupId]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] deleteEmployeeGroup error: ${err.message}`);
        }
    }
    // ─── Employee Analytics (Advanced) ──────────────────────────────
    /**
     * Get message volume per employee per day (for timeline charts)
     */
    getEmployeeMessageTimeline(sinceTs, untilTs) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT
                    employee_id,
                    CAST((timestamp - ?) / 86400000 AS INTEGER) as day_index,
                    COUNT(*) as count,
                    SUM(CASE WHEN action = 'sent' THEN 1 ELSE 0 END) as sent,
                    SUM(CASE WHEN action = 'received' THEN 1 ELSE 0 END) as received
                 FROM employee_message_log
                 WHERE timestamp >= ? AND timestamp <= ?
                 GROUP BY employee_id, day_index
                 ORDER BY day_index ASC`, [sinceTs, sinceTs, untilTs]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeMessageTimeline error: ${err.message}`);
            return [];
        }
    }
    /**
     * Get online hours breakdown per employee per day
     */
    getEmployeeOnlineTimeline(sinceTs, untilTs) {
        if (!this.initialized)
            return [];
        try {
            const sessions = this.query(`SELECT es.employee_id, es.connected_at, es.disconnected_at
                 FROM employee_sessions es
                 WHERE es.connected_at <= ? AND (es.disconnected_at >= ? OR es.disconnected_at IS NULL)
                 ORDER BY es.connected_at ASC`, [untilTs, sinceTs]);
            // Build per-employee per-day hours
            const dayMs = 86400000;
            const result = [];
            const map = new Map(); // employeeId -> dayIndex -> ms
            for (const s of sessions) {
                const start = Math.max(s.connected_at, sinceTs);
                const end = Math.min(s.disconnected_at || Date.now(), untilTs);
                if (end <= start)
                    continue;
                if (!map.has(s.employee_id))
                    map.set(s.employee_id, new Map());
                const empMap = map.get(s.employee_id);
                // Split across days
                let cursor = start;
                while (cursor < end) {
                    const dayIdx = Math.floor((cursor - sinceTs) / dayMs);
                    const dayEnd = sinceTs + (dayIdx + 1) * dayMs;
                    const segmentEnd = Math.min(end, dayEnd);
                    const ms = segmentEnd - cursor;
                    empMap.set(dayIdx, (empMap.get(dayIdx) || 0) + ms);
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
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeOnlineTimeline error: ${err.message}`);
            return [];
        }
    }
    /**
     * Get response time distribution for all employees (buckets: <1m, 1-5m, 5-15m, 15-30m, 30-60m, 1-4h, 4-24h, >24h)
     */
    getEmployeeResponseDistribution(sinceTs, untilTs) {
        if (!this.initialized)
            return [];
        try {
            const rows = this.query(`SELECT employee_id,
                    CAST(json_extract(metadata, '$.response_time_ms') AS REAL) as rt_ms
                 FROM employee_message_log
                 WHERE action = 'replied'
                   AND json_extract(metadata, '$.response_time_ms') IS NOT NULL
                   AND timestamp >= ? AND timestamp <= ?`, [sinceTs, untilTs]);
            const buckets = ['<1m', '1-5m', '5-15m', '15-30m', '30-60m', '1-4h', '4-24h', '>24h'];
            const empBuckets = new Map();
            for (const row of rows) {
                if (!empBuckets.has(row.employee_id)) {
                    empBuckets.set(row.employee_id, new Array(8).fill(0));
                }
                const b = empBuckets.get(row.employee_id);
                const ms = row.rt_ms;
                if (ms < 60000)
                    b[0]++;
                else if (ms < 300000)
                    b[1]++;
                else if (ms < 900000)
                    b[2]++;
                else if (ms < 1800000)
                    b[3]++;
                else if (ms < 3600000)
                    b[4]++;
                else if (ms < 14400000)
                    b[5]++;
                else if (ms < 86400000)
                    b[6]++;
                else
                    b[7]++;
            }
            const result = [];
            for (const [employee_id, counts] of empBuckets) {
                buckets.forEach((bucket, i) => {
                    if (counts[i] > 0)
                        result.push({ employee_id, bucket, count: counts[i] });
                });
            }
            return result;
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeResponseDistribution error: ${err.message}`);
            return [];
        }
    }
    /**
     * Get hourly activity pattern for employees (which hours they are most active)
     */
    getEmployeeHourlyActivity(sinceTs, untilTs) {
        if (!this.initialized)
            return [];
        try {
            return this.query(`SELECT
                    employee_id,
                    CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
                    COUNT(*) as count
                 FROM employee_message_log
                 WHERE timestamp >= ? AND timestamp <= ?
                 GROUP BY employee_id, hour
                 ORDER BY hour ASC`, [sinceTs, untilTs]);
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeHourlyActivity error: ${err.message}`);
            return [];
        }
    }
    /**
     * Comprehensive all-employees comparison for a date range
     */
    getEmployeeComparison(sinceTs, untilTs) {
        if (!this.initialized)
            return [];
        try {
            const employees = this.query(`SELECT employee_id, display_name, avatar_url, role, is_active, group_id FROM employees ORDER BY display_name ASC`);
            return employees.map((emp) => {
                const stats = this.getEmployeeStats(emp.employee_id, sinceTs, untilTs);
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
        }
        catch (err) {
            Logger_1.default.error(`[DB] getEmployeeComparison error: ${err.message}`);
            return [];
        }
    }
    // ─── Facebook Integration Methods ────────────────────────────────────────────
    // ── FB Accounts ──
    saveFBAccount(account) {
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
    getFBAccounts() {
        return this.query(`SELECT * FROM fb_accounts ORDER BY created_at ASC`);
    }
    getFBAccount(id) {
        return this.queryOne(`SELECT * FROM fb_accounts WHERE id = ?`, [id]);
    }
    getFBAccountByFacebookId(facebookId) {
        return this.queryOne(`SELECT * FROM fb_accounts WHERE facebook_id = ?`, [facebookId]);
    }
    updateFBAccountStatus(id, status) {
        this.run(`UPDATE fb_accounts SET status = ?, updated_at = ? WHERE id = ?`, [status, Date.now(), id]);
    }
    updateFBAccountSession(id, sessionData) {
        this.run(`UPDATE fb_accounts SET session_data = ?, last_cookie_check = ?, updated_at = ? WHERE id = ?`, [sessionData, Date.now(), Date.now(), id]);
    }
    updateFBAccountProfile(id, name, avatarUrl, facebookId) {
        this.run(`UPDATE fb_accounts SET name = ?, avatar_url = ?, facebook_id = ?, updated_at = ? WHERE id = ?`, [name, avatarUrl, facebookId, Date.now(), id]);
    }
    deleteFBAccount(id) {
        this.run(`DELETE FROM fb_messages WHERE account_id = ?`, [id]);
        this.run(`DELETE FROM fb_threads WHERE account_id = ?`, [id]);
        this.run(`DELETE FROM fb_crm_contacts WHERE fb_account_id = ?`, [id]);
        this.run(`DELETE FROM fb_accounts WHERE id = ?`, [id]);
    }
    // ── FB Threads ──
    saveFBThread(thread) {
        const now = Date.now();
        this.run(`
            INSERT INTO fb_threads (id, account_id, name, type, emoji, participant_count,
                last_message_preview, last_message_at, unread_count, is_muted, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, type = excluded.type, emoji = excluded.emoji,
              participant_count = excluded.participant_count,
              last_message_preview = excluded.last_message_preview,
              last_message_at = excluded.last_message_at,
              synced_at = excluded.synced_at
        `, [thread.id, thread.account_id, thread.name, thread.type, thread.emoji || null,
            thread.participant_count, thread.last_message_preview || null,
            thread.last_message_at || null, thread.unread_count, thread.is_muted, now]);
    }
    saveFBThreads(accountId, threads) {
        // Resolve facebook_id (numeric UID) for unified contacts table
        // accountId here is internal UUID, but contacts.owner_zalo_id uses facebook_id
        let ownerZaloId = accountId;
        try {
            const fbAcc = this.queryOne(`SELECT facebook_id FROM fb_accounts WHERE id = ?`, [accountId]);
            if (fbAcc?.facebook_id)
                ownerZaloId = fbAcc.facebook_id;
        }
        catch { }
        for (const t of threads) {
            this.saveFBThread({
                id: t.id, account_id: accountId, name: t.name, type: t.type,
                emoji: t.emoji, participant_count: t.participant_count || 0,
                last_message_preview: t.last_message_preview,
                last_message_at: t.last_message_at, unread_count: t.unread_count || 0,
                is_muted: t.is_muted ? 1 : 0,
            });
            const avatarUrl = t.metadata?.avatar_url || '';
            // Sync to unified contacts table — use facebook_id as owner_zalo_id
            this.run(`
                INSERT INTO contacts (owner_zalo_id, contact_id, display_name, avatar_url, is_friend, contact_type, unread_count, last_message, last_message_time, channel)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'facebook')
                ON CONFLICT(owner_zalo_id, contact_id) DO UPDATE SET
                  display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE contacts.display_name END,
                  avatar_url = CASE WHEN excluded.avatar_url != '' THEN excluded.avatar_url ELSE contacts.avatar_url END,
                  contact_type = excluded.contact_type,
                  last_message = CASE WHEN excluded.last_message_time > COALESCE(contacts.last_message_time, 0) THEN excluded.last_message ELSE contacts.last_message END,
                  last_message_time = MAX(COALESCE(contacts.last_message_time, 0), excluded.last_message_time),
                  unread_count = excluded.unread_count,
                  channel = 'facebook'
            `, [ownerZaloId, t.id, t.name || '', avatarUrl, t.type === 'group' ? 'group' : 'user',
                t.unread_count || 0, t.last_message_preview || '', t.last_message_at || 0]);
        }
    }
    getFBThreads(accountId) {
        return this.query(`SELECT * FROM fb_threads WHERE account_id = ? ORDER BY last_message_at DESC NULLS LAST`, [accountId]);
    }
    updateFBThreadUnread(accountId, threadId, count) {
        this.run(`UPDATE fb_threads SET unread_count = ? WHERE id = ? AND account_id = ?`, [count, threadId, accountId]);
    }
    markFBThreadAsRead(accountId, threadId) {
        this.run(`UPDATE fb_threads SET unread_count = 0 WHERE id = ? AND account_id = ?`, [threadId, accountId]);
    }
    // ── FB Messages ──
    saveFBMessage(msg) {
        const now = Date.now();
        Logger_1.default.log(`[DB:saveFBMessage] id=${msg.id} account_id=${msg.account_id} thread_id=${msg.thread_id} sender=${msg.sender_id} is_self=${msg.is_self} body="${(msg.body || '').slice(0, 50)}"`);
        this.run(`
            INSERT OR IGNORE INTO fb_messages
              (id, account_id, thread_id, sender_id, sender_name, body, timestamp, type,
               attachments, reply_to_id, is_self, is_unsent, reactions, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [msg.id, msg.account_id, msg.thread_id, msg.sender_id, msg.sender_name || '',
            msg.body || null, msg.timestamp, msg.type, msg.attachments || '[]',
            msg.reply_to_id || null, msg.is_self, msg.is_unsent, msg.reactions || '{}', now]);
        // Also save to unified messages table — use facebook_id as owner_zalo_id
        let ownerZaloId = msg.account_id;
        try {
            const fbAcc = this.queryOne(`SELECT facebook_id FROM fb_accounts WHERE id = ?`, [msg.account_id]);
            Logger_1.default.log(`[DB:saveFBMessage] Resolved fbAcc: ${JSON.stringify(fbAcc)} → ownerZaloId will be: ${fbAcc?.facebook_id || msg.account_id}`);
            if (fbAcc?.facebook_id)
                ownerZaloId = fbAcc.facebook_id;
        }
        catch (e) {
            Logger_1.default.warn(`[DB:saveFBMessage] Failed to resolve facebook_id: ${e.message}`);
        }
        Logger_1.default.log(`[DB:saveFBMessage] INSERT INTO messages: msg_id=${msg.id} owner_zalo_id=${ownerZaloId} thread_id=${msg.thread_id} is_sent=${msg.is_self} channel=facebook`);
        // Generate display content for unified messages table when body is empty
        const displayContent = msg.body || (() => {
            if (msg.type === 'image' || msg.type === 'photo')
                return '🖼️ Hình ảnh';
            if (msg.type === 'video')
                return '🎬 Video';
            if (msg.type === 'audio')
                return '🎵 Audio';
            if (msg.type !== 'text') {
                try {
                    const atts = JSON.parse(msg.attachments || '[]');
                    const name = atts[0]?.name;
                    return name ? `📎 ${name}` : '📎 Tệp đính kèm';
                }
                catch {
                    return '📎 Tệp đính kèm';
                }
            }
            return '';
        })();
        this.run(`
            INSERT OR IGNORE INTO messages
              (msg_id, owner_zalo_id, thread_id, thread_type, sender_id, content, msg_type, timestamp, is_sent, attachments, status, channel)
            VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'facebook')
        `, [msg.id, ownerZaloId, msg.thread_id, msg.sender_id,
            displayContent, msg.type || 'text', msg.timestamp,
            msg.is_self, msg.attachments || '[]', msg.is_self ? 'sent' : 'received']);
        // Update thread preview
        if (!msg.is_unsent) {
            this.run(`
                UPDATE fb_threads SET last_message_preview = ?, last_message_at = ?,
                  unread_count = unread_count + ?
                WHERE id = ? AND account_id = ?
            `, [msg.body?.slice(0, 100) || (msg.type === 'image' ? '🖼️ Hình ảnh' : msg.type === 'video' ? '🎬 Video' : msg.type === 'audio' ? '🎵 Audio' : '[Tệp đính kèm]'), msg.timestamp,
                msg.is_self ? 0 : 1, msg.thread_id, msg.account_id]);
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
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }
    }
    getFBMessages(accountId, threadId, limit = 50, offset = 0) {
        return this.query(`SELECT * FROM fb_messages
             WHERE account_id = ? AND thread_id = ?
             ORDER BY timestamp DESC
             LIMIT ? OFFSET ?`, [accountId, threadId, limit, offset]);
    }
    updateFBMessageUnsent(id) {
        this.run(`UPDATE fb_messages SET is_unsent = 1, body = null WHERE id = ?`, [id]);
        this.run(`UPDATE messages SET is_recalled = 1, content = '' WHERE msg_id = ? AND channel = 'facebook'`, [id]);
    }
    updateFBMessageReaction(id, reactions) {
        this.run(`UPDATE fb_messages SET reactions = ? WHERE id = ?`, [reactions, id]);
    }
    hasFBMessage(accountId, messageId) {
        const row = this.queryOne(`SELECT id FROM fb_messages WHERE id = ? AND account_id = ?`, [messageId, accountId]);
        return !!row;
    }
    // ── FB CRM Contacts ──
    saveFBCRMContact(contact) {
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
    getFBCRMContacts(fbAccountId) {
        return this.query(`SELECT * FROM fb_crm_contacts WHERE fb_account_id = ? ORDER BY display_name ASC`, [fbAccountId]);
    }
}
exports.default = DatabaseService;
//# sourceMappingURL=DatabaseService.js.map