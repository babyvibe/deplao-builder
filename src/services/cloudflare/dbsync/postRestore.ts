/**
 * postRestore: safety after a restore (runs on the RESTORED FILE, before it replaces the real DB).
 *
 * The restored copy may run on another machine while the old machine is still alive → two machines must not stay signed in to the channels,
 * run the same campaigns, or sign the employee tokens:
 *  - remove the tracking triggers/tables (_cloud_*): this machine reinstalls them and takes a new base snapshot if sync is on;
 *  - delete the channel login sessions: accounts.cookies (Zalo, Telegram sessions, bot tokens…), the cookie/session columns of fb_accounts,
 *    app_settings 'fb_cookie_*', 'facebook:e2ee-device-state:*';
 *  - 'enc:…' values (safeStorage encryption, only the old machine can decrypt them) → delete;
 *  - change the employee token signing key (employee_jwt_secret) → the employees' old tokens stop working;
 *  - set the flags 'cloud_restore_pending_relogin' and 'cloud_restore_paused_automations' = '1' (read by restoreGate);
 *  - keep 'cloud_workspace_uid' / 'cloud_media_bucket' as they are (the media of the restored DB can still be found on R2).
 */
import { randomBytes } from 'crypto';
import { dropTracking } from './DirtyTracker';
import { SqlConn, quoteIdent, tableExists, toNumber } from './sqlConn';
import { appendLog, clearLog, LogInput } from './syncLog';
import { tableColumns } from './tableSelection';

export const RESTORE_RELOGIN_KEY = 'cloud_restore_pending_relogin';
export const RESTORE_PAUSED_KEY = 'cloud_restore_paused_automations';
export const RESTORE_SOURCE_KEY = 'cloud_restore_source';
export const JWT_SECRET_KEY = 'employee_jwt_secret';
export const JWT_SECRET_VERSION_KEY = 'employee_jwt_secret_version';

/** Key prefix in app_settings that holds channel login sessions: delete the whole row. */
export const CREDENTIAL_SETTING_PREFIXES: readonly string[] = ['fb_cookie_', 'facebook:e2ee-device-state:'];
/** Prefix of safeStorage-encrypted values (SecureSettingsService, secretBox, AIAssistantService). */
export const ENC_PREFIX = 'enc:';
/** Columns (outside app_settings) that may hold 'enc:…' values → set to empty (keeps the config row, the user enters the keys again). */
export const ENCRYPTED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
    { table: 'ai_assistants', column: 'api_key_encrypted' },
    { table: 'webhook_subscriptions', column: 'secret' },
];

export interface PostRestoreInfo {
    source: {
        bucket: string;
        workspaceUid: string;
        machineId: string;
        machineName: string;
        baseAt: number | null;
        untilTs: number | null;
        appliedSegments: number;
    };
    restoredAt: number;
    /** The 'restore' row written to the restored copy's cloud_sync_log (the source machine's old log is deleted). */
    logEntry?: LogInput | null;
}

export interface PostRestoreReport {
    trackingDropped: boolean;
    accountsCleared: number;
    fbAccountsCleared: number;
    settingsDeleted: number;
    encryptedCleared: number;
}

function hasColumn(conn: SqlConn, table: string, column: string): boolean {
    if (!tableExists(conn, table)) return false;
    return tableColumns(conn, table).all.some(c => c.toLowerCase() === column.toLowerCase());
}

function upsertSetting(conn: SqlConn, key: string, value: string): void {
    conn.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value);
}

export function applyPostRestoreSafety(conn: SqlConn, info: PostRestoreInfo): PostRestoreReport {
    const dropped = dropTracking(conn);
    const report: PostRestoreReport = {
        trackingDropped: dropped.triggers > 0 || dropped.tables > 0,
        accountsCleared: 0,
        fbAccountsCleared: 0,
        settingsDeleted: 0,
        encryptedCleared: 0,
    };
    conn.exec('BEGIN IMMEDIATE');
    try {
        // Login sessions of every channel (Zalo cookies, GramJS sessions, Telegram bot tokens…). NOT NULL column → empty string.
        if (hasColumn(conn, 'accounts', 'cookies')) {
            report.accountsCleared = toNumber(conn.prepare("UPDATE accounts SET cookies = '' WHERE cookies IS NOT NULL AND cookies <> ''").run().changes);
        }
        if (tableExists(conn, 'fb_accounts')) {
            const sets: string[] = [];
            for (const col of ['cookie_encrypted', 'session_data']) {
                if (hasColumn(conn, 'fb_accounts', col)) sets.push(`${quoteIdent(col)} = ''`);
            }
            if (sets.length) report.fbAccountsCleared = toNumber(conn.prepare(`UPDATE fb_accounts SET ${sets.join(', ')}`).run().changes);
        }
        if (tableExists(conn, 'app_settings')) {
            const conds = CREDENTIAL_SETTING_PREFIXES.map(p => `substr(key, 1, ${p.length}) = '${p.replace(/'/g, "''")}'`);
            conds.push(`substr(value, 1, ${ENC_PREFIX.length}) = '${ENC_PREFIX}'`);
            report.settingsDeleted = toNumber(conn.prepare(`DELETE FROM app_settings WHERE ${conds.join(' OR ')}`).run().changes);
            // New employee token signing key (48 bytes base64url, like employeeTokenPolicy.generateJwtSecret)
            upsertSetting(conn, JWT_SECRET_KEY, randomBytes(48).toString('base64url'));
            upsertSetting(conn, JWT_SECRET_VERSION_KEY, '2');
            upsertSetting(conn, RESTORE_RELOGIN_KEY, '1');
            upsertSetting(conn, RESTORE_PAUSED_KEY, '1');
            upsertSetting(conn, RESTORE_SOURCE_KEY, JSON.stringify({ ...info.source, restoredAt: info.restoredAt }));
        }
        for (const { table, column } of ENCRYPTED_COLUMNS) {
            if (!hasColumn(conn, table, column)) continue;
            const c = quoteIdent(column);
            report.encryptedCleared += toNumber(
                conn.prepare(`UPDATE ${quoteIdent(table)} SET ${c} = '' WHERE substr(${c}, 1, ${ENC_PREFIX.length}) = '${ENC_PREFIX}'`).run().changes,
            );
        }
        clearLog(conn);
        if (info.logEntry) appendLog(conn, info.logEntry);
        conn.exec('COMMIT');
    } catch (err) {
        try { conn.exec('ROLLBACK'); } catch { /* cancelled */ }
        throw err;
    }
    return report;
}
