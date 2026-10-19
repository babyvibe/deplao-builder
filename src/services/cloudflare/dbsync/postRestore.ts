/**
 * postRestore — an toàn sau khi khôi phục (chạy trên FILE đã khôi phục, trước khi thay vào chỗ DB thật).
 *
 * Bản khôi phục có thể chạy trên máy khác trong khi máy cũ vẫn sống → không được để hai máy cùng đăng nhập kênh,
 * cùng chạy chiến dịch, cùng ký token nhân viên:
 *  - gỡ trigger/bảng theo dõi (_cloud_*) — máy này tự cài lại và chụp gốc mới nếu bật đồng bộ;
 *  - xoá phiên đăng nhập kênh: accounts.cookies (Zalo, phiên Telegram, token bot…), cột cookie/phiên của fb_accounts,
 *    app_settings 'fb_cookie_*', 'facebook:e2ee-device-state:*';
 *  - giá trị 'enc:…' (mã hoá safeStorage — chỉ máy cũ giải mã được) → xoá;
 *  - đổi khoá ký token nhân viên (employee_jwt_secret) → token cũ của nhân viên hết hiệu lực;
 *  - bật cờ 'cloud_restore_pending_relogin' và 'cloud_restore_paused_automations' = '1' (restoreGate đọc);
 *  - giữ nguyên 'cloud_workspace_uid' / 'cloud_media_bucket' (media của DB khôi phục vẫn tìm được trên R2).
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

/** Tiền tố khoá app_settings chứa phiên đăng nhập kênh — xoá cả dòng. */
export const CREDENTIAL_SETTING_PREFIXES: readonly string[] = ['fb_cookie_', 'facebook:e2ee-device-state:'];
/** Tiền tố giá trị mã hoá safeStorage (SecureSettingsService, secretBox, AIAssistantService). */
export const ENC_PREFIX = 'enc:';
/** Cột (ngoài app_settings) có thể chứa giá trị 'enc:…' → đặt rỗng (giữ dòng cấu hình, người dùng nhập lại khoá). */
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
    /** Dòng 'restore' ghi vào cloud_sync_log của bản khôi phục (nhật ký cũ của máy nguồn được xoá). */
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
        // Phiên đăng nhập mọi kênh (Zalo cookies, phiên GramJS, token bot Telegram…). Cột NOT NULL → chuỗi rỗng.
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
            // Khoá ký token nhân viên mới (48 byte base64url như employeeTokenPolicy.generateJwtSecret)
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
        try { conn.exec('ROLLBACK'); } catch { /* đã huỷ */ }
        throw err;
    }
    return report;
}
