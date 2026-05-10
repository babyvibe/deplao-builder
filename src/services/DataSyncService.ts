import Logger from '../utils/Logger';
import DatabaseService from './DatabaseService';

/**
 * Tables to sync from Boss → Employee, filtered by assigned zaloIds.
 * Employee = same data as Boss for assigned accounts (just different permissions).
 * NOT synced: employees*, employee_permissions, employee_account_access,
 *             employee_sessions, employee_groups (boss-only management tables)
 */
const SYNCABLE_TABLES_BY_ZALO = [
    // Core data
    { table: 'messages',               zaloCol: 'owner_zalo_id',  tsCol: 'timestamp' },
    { table: 'contacts',               zaloCol: 'owner_zalo_id',  tsCol: 'last_message_time' },
    { table: 'friends',                zaloCol: 'owner_zalo_id',  tsCol: 'updated_at' },
    { table: 'page_group_member',      zaloCol: 'owner_zalo_id',  tsCol: 'updated_at' },
    { table: 'links',                  zaloCol: 'owner_zalo_id',  tsCol: 'timestamp' },
    { table: 'friend_requests',        zaloCol: 'owner_zalo_id',  tsCol: 'updated_at' },
    { table: 'pinned_messages',        zaloCol: 'owner_zalo_id',  tsCol: 'pinned_at' },
    { table: 'local_pinned_conversations', zaloCol: 'owner_zalo_id', tsCol: 'pinned_at' },
    { table: 'local_quick_messages',   zaloCol: 'owner_zalo_id',  tsCol: 'updated_at' },
    { table: 'local_label_threads',    zaloCol: 'owner_zalo_id',  tsCol: 'created_at' },
    // CRM
    { table: 'crm_tags',              zaloCol: 'owner_zalo_id',  tsCol: 'created_at' },
    { table: 'crm_contact_tags',      zaloCol: 'owner_zalo_id',  tsCol: null },
    { table: 'crm_notes',            zaloCol: 'owner_zalo_id',  tsCol: 'updated_at' },
    { table: 'crm_campaigns',        zaloCol: 'owner_zalo_id',  tsCol: 'updated_at' },
    { table: 'crm_campaign_contacts', zaloCol: 'owner_zalo_id',  tsCol: 'sent_at' },
    { table: 'crm_send_log',         zaloCol: 'owner_zalo_id',  tsCol: 'sent_at' },
    // Bank cards
    { table: 'bank_cards',           zaloCol: 'owner_zalo_id',  tsCol: 'updated_at' },
    // Message drafts
    { table: 'message_drafts',       zaloCol: 'owner_zalo_id',  tsCol: 'updated_at' },
    // Employee message log (for the assigned accounts)
    { table: 'employee_message_log', zaloCol: 'zalo_id',        tsCol: 'timestamp' },
];

/** Tables synced fully (device-wide, no zaloId filter) */
const SYNCABLE_TABLES_GLOBAL = [
    { table: 'stickers',              tsCol: 'updated_at' },
    { table: 'sticker_packs',         tsCol: 'updated_at' },
    { table: 'recent_stickers',       tsCol: 'used_at' },
    { table: 'keyword_stickers',      tsCol: 'updated_at' },
    { table: 'local_labels',          tsCol: 'updated_at' },
    { table: 'app_settings',          tsCol: null },
    // AI assistants & usage
    { table: 'ai_assistants',         tsCol: 'updated_at' },
    { table: 'ai_assistant_files',    tsCol: 'created_at' },
    { table: 'ai_account_assistants', tsCol: null },
    { table: 'ai_usage_logs',         tsCol: 'created_at' },
    // Workflows
    { table: 'workflows',             tsCol: 'updated_at' },
    { table: 'workflow_run_logs',     tsCol: 'started_at' },
    // Integrations
    { table: 'integrations',          tsCol: 'updated_at' },
    // ─── ERP module (Phase 1) — shared within the workspace ────────
    // NOTE: `erp_notifications` is intentionally NOT synced — each actor
    // manages their own inbox locally to avoid noisy cross-device fan-out.
    { table: 'erp_projects',          tsCol: 'updated_at' },
    { table: 'erp_tasks',             tsCol: 'updated_at' },
    { table: 'erp_task_assignees',    tsCol: 'assigned_at' },
    { table: 'erp_task_checklist',    tsCol: 'created_at' },
    { table: 'erp_task_comments',     tsCol: 'updated_at' },
    { table: 'erp_task_attachments',  tsCol: 'uploaded_at' },
    { table: 'erp_task_activity_log', tsCol: 'created_at' },
    { table: 'erp_calendar_events',   tsCol: 'updated_at' },
    { table: 'erp_event_reminders',   tsCol: null },
    { table: 'erp_note_folders',      tsCol: 'created_at' },
    { table: 'erp_notes',             tsCol: 'updated_at' },
    { table: 'erp_note_tags',         tsCol: null },
    { table: 'erp_note_tag_map',      tsCol: null },
    { table: 'erp_note_versions',     tsCol: 'created_at' },
    // ─── ERP Phase 2 ──────────────────────────────────────────────
    { table: 'erp_task_watchers',     tsCol: 'added_at' },
    { table: 'erp_task_dependencies', tsCol: 'created_at' },
    { table: 'erp_event_attendees',   tsCol: null },
    { table: 'erp_note_shares',       tsCol: null },
    { table: 'erp_departments',       tsCol: 'updated_at' },
    { table: 'erp_positions',         tsCol: 'created_at' },
    { table: 'erp_employee_profiles', tsCol: 'updated_at' },
    { table: 'erp_attendance',        tsCol: 'updated_at' },
    { table: 'erp_leave_requests',    tsCol: 'updated_at' },
];

const PRIVACY_FILTERED_ERP_TABLES = new Set([
    'erp_calendar_events',
    'erp_event_reminders',
    'erp_event_attendees',
    'erp_note_folders',
    'erp_notes',
    'erp_note_tags',
    'erp_note_tag_map',
    'erp_note_versions',
    'erp_note_shares',
]);

/** Account info to sync (no imei/user_agent/cookies — employee doesn't need login credentials) */
const ACCOUNT_SAFE_COLUMNS = 'zalo_id, full_name, avatar_url, phone, is_business, is_active, last_seen, listener_active';

export interface SyncPayload {
    /** Timestamp of this sync snapshot */
    syncTs: number;
    /** Whether this is a full or delta sync */
    type: 'full' | 'delta';
    /** Account safe info */
    accounts: any[];
    /** Table data keyed by table name */
    tables: Record<string, any[]>;
}

interface ProgressCallback {
    (phase: string, percent: number): void;
}

/**
 * DataSyncService — Handles DB sync between Boss and Employee machines.
 *
 * Boss side: exports filtered data for employee's assigned zaloIds.
 * Employee side: imports data into local DB.
 */
class DataSyncService {
    private static instance: DataSyncService;

    public static getInstance(): DataSyncService {
        if (!DataSyncService.instance) {
            DataSyncService.instance = new DataSyncService();
        }
        return DataSyncService.instance;
    }

    // ─── Boss Side: Export ──────────────────────────────────────────────

    /**
     * Export a full snapshot of the DB filtered for the given zaloIds.
     * Used for initial sync when employee first connects.
     */
    public exportFullSync(zaloIds: string[], employeeId?: string): SyncPayload {
        const db = DatabaseService.getInstance();
        const syncTs = Date.now();
        const tables: Record<string, any[]> = {};

        // Safe account info (no imei, user_agent, cookies)
        const placeholders = zaloIds.map(() => '?').join(',');
        const accounts = db.query<any>(
            `SELECT ${ACCOUNT_SAFE_COLUMNS} FROM accounts WHERE zalo_id IN (${placeholders})`,
            zaloIds
        );

        // Export zaloId-filtered tables (paginated to limit peak memory)
        const PAGE_SIZE = 5000;
        for (const spec of SYNCABLE_TABLES_BY_ZALO) {
            try {
                let offset = 0;
                let allRows: any[] = [];
                while (true) {
                    const batch = db.query<any>(
                        `SELECT * FROM ${spec.table} WHERE ${spec.zaloCol} IN (${placeholders}) LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
                        zaloIds
                    );
                    if (batch.length === 0) break;
                    allRows = allRows.concat(batch);
                    if (batch.length < PAGE_SIZE) break;
                    offset += PAGE_SIZE;
                }
                if (allRows.length > 0) {
                    tables[spec.table] = allRows;
                }
            } catch (err: any) {
                Logger.warn(`[DataSyncService] Export skip ${spec.table}: ${err.message}`);
            }
        }

        // Export global tables (paginated)
        for (const spec of SYNCABLE_TABLES_GLOBAL) {
            if (employeeId && PRIVACY_FILTERED_ERP_TABLES.has(spec.table)) continue;
            try {
                let offset = 0;
                let allRows: any[] = [];
                while (true) {
                    const batch = db.query<any>(
                        `SELECT * FROM ${spec.table} LIMIT ${PAGE_SIZE} OFFSET ${offset}`
                    );
                    if (batch.length === 0) break;
                    allRows = allRows.concat(batch);
                    if (batch.length < PAGE_SIZE) break;
                    offset += PAGE_SIZE;
                }
                if (allRows.length > 0) {
                    tables[spec.table] = allRows;
                }
            } catch (err: any) {
                Logger.warn(`[DataSyncService] Export skip ${spec.table}: ${err.message}`);
            }
        }

        if (employeeId) this.appendPrivateErpTables(tables, employeeId);

        const totalRows = Object.values(tables).reduce((sum, arr) => sum + arr.length, 0);
        Logger.log(`[DataSyncService] Full export: ${Object.keys(tables).length} tables, ${totalRows} rows for ${zaloIds.length} accounts`);

        return { syncTs, type: 'full', accounts, tables };
    }

    /**
     * Export only rows changed since `sinceTs` for the given zaloIds.
     * Used for incremental sync after reconnect.
     */
    public exportDeltaSync(zaloIds: string[], sinceTs: number, employeeId?: string): SyncPayload {
        const db = DatabaseService.getInstance();
        const syncTs = Date.now();
        const tables: Record<string, any[]> = {};
        const placeholders = zaloIds.map(() => '?').join(',');

        // Safe account info
        const accounts = db.query<any>(
            `SELECT ${ACCOUNT_SAFE_COLUMNS} FROM accounts WHERE zalo_id IN (${placeholders})`,
            zaloIds
        );

        // Export zaloId-filtered tables — only rows with timestamp > sinceTs
        for (const spec of SYNCABLE_TABLES_BY_ZALO) {
            try {
                let rows: any[];
                if (spec.tsCol) {
                    rows = db.query<any>(
                        `SELECT * FROM ${spec.table} WHERE ${spec.zaloCol} IN (${placeholders}) AND ${spec.tsCol} > ?`,
                        [...zaloIds, sinceTs]
                    );
                } else {
                    // No timestamp column — full re-export for this table
                    rows = db.query<any>(
                        `SELECT * FROM ${spec.table} WHERE ${spec.zaloCol} IN (${placeholders})`,
                        zaloIds
                    );
                }
                if (rows.length > 0) {
                    tables[spec.table] = rows;
                }
            } catch (err: any) {
                Logger.warn(`[DataSyncService] Delta skip ${spec.table}: ${err.message}`);
            }
        }

        // Global tables — only changed rows
        for (const spec of SYNCABLE_TABLES_GLOBAL) {
            if (employeeId && PRIVACY_FILTERED_ERP_TABLES.has(spec.table)) continue;
            try {
                let rows: any[];
                if (spec.tsCol) {
                    rows = db.query<any>(
                        `SELECT * FROM ${spec.table} WHERE ${spec.tsCol} > ?`,
                        [sinceTs]
                    );
                } else {
                    rows = db.query<any>(`SELECT * FROM ${spec.table}`);
                }
                if (rows.length > 0) {
                    tables[spec.table] = rows;
                }
            } catch (err: any) {
                Logger.warn(`[DataSyncService] Delta skip ${spec.table}: ${err.message}`);
            }
        }

        if (employeeId) this.appendPrivateErpTables(tables, employeeId);

        const totalRows = Object.values(tables).reduce((sum, arr) => sum + arr.length, 0);
        Logger.log(`[DataSyncService] Delta export (since ${new Date(sinceTs).toISOString()}): ${Object.keys(tables).length} tables, ${totalRows} rows`);

        return { syncTs, type: 'delta', accounts, tables };
    }

    // ─── Employee Side: Import ─────────────────────────────────────────

    /**
     * Import a full sync payload: clear relevant tables, then insert.
     */
    public importFullSync(payload: SyncPayload, zaloIds: string[], onProgress?: ProgressCallback): void {
        const db = DatabaseService.getInstance();
        const inClause = zaloIds.map(id => `'${this.esc(id)}'`).join(',');

        onProgress?.('Đang xóa dữ liệu cũ...', 5);

        // Clear existing data for assigned zaloIds in zaloId-filtered tables
        for (const spec of SYNCABLE_TABLES_BY_ZALO) {
            try {
                db.exec(`DELETE FROM ${spec.table} WHERE ${spec.zaloCol} IN (${inClause})`);
            } catch {}
        }

        // Clear global tables
        for (const spec of SYNCABLE_TABLES_GLOBAL) {
            try {
                db.exec(`DELETE FROM ${spec.table}`);
            } catch {}
        }

        // Clear old account info
        try {
            db.exec(`DELETE FROM accounts WHERE zalo_id IN (${inClause})`);
        } catch {}

        onProgress?.('Đang nhập tài khoản...', 10);

        // Import safe account info (create minimal account records)
        for (const acc of payload.accounts || []) {
            try {
                db.exec(`INSERT OR REPLACE INTO accounts (zalo_id, full_name, avatar_url, phone, is_business, is_active, last_seen, listener_active, imei, user_agent, cookies, created_at)
                    VALUES ('${this.esc(acc.zalo_id)}', '${this.esc(acc.full_name)}', '${this.esc(acc.avatar_url)}', '${this.esc(acc.phone || '')}', ${acc.is_business || 0}, ${acc.is_active || 1}, '${this.esc(acc.last_seen || '')}', ${acc.listener_active ?? 1}, '', '', '', '${new Date().toISOString()}')`);
            } catch (err: any) {
                Logger.warn(`[DataSyncService] Import account error: ${err.message}`);
            }
        }

        // Import tables
        const tableNames = Object.keys(payload.tables || {});
        let tableIdx = 0;
        for (const tableName of tableNames) {
            const rows = payload.tables[tableName];
            if (!rows || rows.length === 0) continue;

            const percent = 10 + Math.round((tableIdx / tableNames.length) * 85);
            onProgress?.(`Đang nhập ${tableName} (${rows.length} dòng)...`, percent);

            this.bulkInsert(db, tableName, rows);
            tableIdx++;
        }

        // Save
        db.forceFlush();
        onProgress?.('Hoàn tất đồng bộ!', 100);
        Logger.log(`[DataSyncService] Full import complete: ${tableNames.length} tables`);
    }

    /**
     * Import a delta sync payload: upsert changed rows.
     */
    public importDeltaSync(payload: SyncPayload, onProgress?: ProgressCallback): void {
        const db = DatabaseService.getInstance();

        onProgress?.('Đang cập nhật tài khoản...', 5);

        // Update account safe info
        for (const acc of payload.accounts || []) {
            try {
                db.exec(`UPDATE accounts SET full_name='${this.esc(acc.full_name)}', avatar_url='${this.esc(acc.avatar_url)}', phone='${this.esc(acc.phone || '')}', is_active=${acc.is_active || 1}, listener_active=${acc.listener_active ?? 1} WHERE zalo_id='${this.esc(acc.zalo_id)}'`);
            } catch {}
        }

        // Upsert tables
        const tableNames = Object.keys(payload.tables || {});
        for (const tableName of tableNames) {
            if (!PRIVACY_FILTERED_ERP_TABLES.has(tableName)) continue;
            try {
                db.exec(`DELETE FROM ${tableName}`);
            } catch {}
        }
        let tableIdx = 0;
        for (const tableName of tableNames) {
            const rows = payload.tables[tableName];
            if (!rows || rows.length === 0) continue;

            const percent = 5 + Math.round((tableIdx / tableNames.length) * 90);
            onProgress?.(`Đang cập nhật ${tableName} (${rows.length})...`, percent);

            this.bulkInsert(db, tableName, rows);
            tableIdx++;
        }

        db.forceFlush();
        onProgress?.('Hoàn tất cập nhật!', 100);
        Logger.log(`[DataSyncService] Delta import complete: ${tableNames.length} tables`);
    }

    /**
     * Reset local employee DB: delete all synced data.
     */
    public resetEmployeeDB(zaloIds: string[]): void {
        const db = DatabaseService.getInstance();
        const inClause = zaloIds.map(id => `'${this.esc(id)}'`).join(',');

        for (const spec of SYNCABLE_TABLES_BY_ZALO) {
            try {
                db.exec(`DELETE FROM ${spec.table} WHERE ${spec.zaloCol} IN (${inClause})`);
            } catch {}
        }
        for (const spec of SYNCABLE_TABLES_GLOBAL) {
            try {
                db.exec(`DELETE FROM ${spec.table}`);
            } catch {}
        }
        try {
            db.exec(`DELETE FROM accounts WHERE zalo_id IN (${inClause})`);
        } catch {}

        db.forceFlush();
        Logger.log(`[DataSyncService] Employee DB reset for ${zaloIds.length} accounts`);
    }

    private appendPrivateErpTables(tables: Record<string, any[]>, employeeId: string): void {
        const db = DatabaseService.getInstance();

        tables.erp_calendar_events = [];
        tables.erp_event_reminders = [];
        tables.erp_event_attendees = [];
        tables.erp_note_folders = [];
        tables.erp_notes = [];
        tables.erp_note_shares = [];
        tables.erp_note_versions = [];
        tables.erp_note_tag_map = [];
        tables.erp_note_tags = [];

        const calendarEvents = this.getAccessibleCalendarEvents(db, employeeId);
        if (calendarEvents.length > 0) {
            const eventIds = calendarEvents.map((row: any) => row.id);
            tables.erp_calendar_events = calendarEvents;
            tables.erp_event_reminders = this.queryByIds(db, 'erp_event_reminders', 'event_id', eventIds);
            tables.erp_event_attendees = this.queryByIds(db, 'erp_event_attendees', 'event_id', eventIds);
        }

        const notes = this.getAccessibleNotes(db, employeeId);
        const ownedFolders = this.getOwnedNoteFolders(db, employeeId);
        if (ownedFolders.length > 0) tables.erp_note_folders = ownedFolders;
        if (notes.length > 0) {
            const noteIds = notes.map((row: any) => row.id);
            tables.erp_notes = notes;
            tables.erp_note_shares = this.queryByIds(db, 'erp_note_shares', 'note_id', noteIds);
            tables.erp_note_versions = this.queryByIds(db, 'erp_note_versions', 'note_id', noteIds);
            tables.erp_note_tag_map = this.queryByIds(db, 'erp_note_tag_map', 'note_id', noteIds);
            const tagIds = Array.from(new Set((tables.erp_note_tag_map || []).map((row: any) => row.tag_id).filter((id: any) => id !== null && id !== undefined)));
            if (tagIds.length > 0) {
                tables.erp_note_tags = this.queryByIds(db, 'erp_note_tags', 'id', tagIds);
            }
        }
    }

    private getAccessibleCalendarEvents(db: DatabaseService, employeeId: string): any[] {
        const params: any[] = [employeeId, employeeId];
        let sql = `
            SELECT DISTINCT e.*
            FROM erp_calendar_events e
            LEFT JOIN erp_event_attendees a ON a.event_id = e.id
            WHERE (e.organizer_id = ? OR a.employee_id = ?)
        `;
        return db.query<any>(sql, params);
    }

    private getOwnedNoteFolders(db: DatabaseService, employeeId: string): any[] {
        return db.query<any>('SELECT * FROM erp_note_folders WHERE owner_id = ?', [employeeId]);
    }

    private getAccessibleNotes(db: DatabaseService, employeeId: string): any[] {
        const params: any[] = [employeeId, employeeId];
        let sql = `
            SELECT DISTINCT n.*
            FROM erp_notes n
            LEFT JOIN erp_note_shares s ON s.note_id = n.id
            WHERE (n.author_id = ? OR n.share_scope = 'workspace' OR s.employee_id = ?)
        `;
        return db.query<any>(sql, params);
    }

    private queryByIds(db: DatabaseService, tableName: string, column: string, ids: Array<string | number>, sinceTs?: number): any[] {
        const normalizedIds = Array.from(new Set(ids.filter(id => id !== null && id !== undefined)));
        if (normalizedIds.length === 0) return [];
        const placeholders = normalizedIds.map(() => '?').join(',');
        const params: any[] = [...normalizedIds];
        let sql = `SELECT * FROM ${tableName} WHERE ${column} IN (${placeholders})`;
        const tsColumn = this.resolveTsColumn(tableName);
        if (sinceTs && tsColumn) {
            sql += ` AND ${tsColumn} > ?`;
            params.push(sinceTs);
        }
        return db.query<any>(sql, params);
    }

    private resolveTsColumn(tableName: string): string | null {
        const byZalo = SYNCABLE_TABLES_BY_ZALO.find(spec => spec.table === tableName);
        if (byZalo?.tsCol) return byZalo.tsCol;
        const global = SYNCABLE_TABLES_GLOBAL.find(spec => spec.table === tableName);
        return global?.tsCol ?? null;
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    /**
     * Bulk INSERT OR REPLACE rows into a table.
     * Infers columns from the first row.
     */
    private bulkInsert(db: DatabaseService, tableName: string, rows: any[]): void {
        if (rows.length === 0) return;

        const cols = Object.keys(rows[0]);
        if (cols.length === 0) return;

        const colList = cols.join(', ');

        let inserted = 0;
        try {
            db.exec(`BEGIN TRANSACTION`);
            for (const row of rows) {
                try {
                    const escapedValues = cols.map(c => {
                        const v = row[c];
                        if (v === null || v === undefined) return 'NULL';
                        if (typeof v === 'number') return String(v);
                        return `'${this.esc(String(v))}'`;
                    }).join(', ');
                    db.exec(`INSERT OR REPLACE INTO ${tableName} (${colList}) VALUES (${escapedValues})`);
                    inserted++;
                } catch {
                    // Skip individual row errors
                }
            }
            db.exec(`COMMIT`);
        } catch (err: any) {
            try { db.exec(`ROLLBACK`); } catch {}
            Logger.warn(`[DataSyncService] bulkInsert ${tableName} transaction error: ${err.message}`);
        }

        if (inserted > 0) {
            Logger.info(`[DataSyncService] Inserted ${inserted}/${rows.length} rows into ${tableName}`);
        }
    }

    /** Escape single quotes for SQL string literals */
    private esc(val: string): string {
        if (!val) return '';
        return String(val).replace(/'/g, "''");
    }
}

export default DataSyncService;

