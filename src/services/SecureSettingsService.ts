/**
 * SecureSettingsService.ts
 * Wrapper quanh electron.safeStorage để mã hóa data nhạy cảm trong SQLite.
 * Data được mã hóa bởi OS (Windows Credential Manager / macOS Keychain).
 * Chỉ app này trên đúng máy này mới giải mã được.
 */
import { safeStorage } from 'electron';
import DatabaseService from './DatabaseService';
import Logger from '../utils/Logger';

const ENC_PREFIX = 'enc:';

/**
 * Lưu value được mã hóa bởi safeStorage vào SQLite settings.
 */
export function secureSet(key: string, value: string): void {
    if (!value && value !== '') {
        DatabaseService.getInstance().setSetting(key, '');
        return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
        // Fallback: lưu plaintext với warning (hiếm gặp — OS không hỗ trợ keychain)
        Logger.warn(`[SecureSettings] safeStorage unavailable — storing "${key}" as plaintext`);
        DatabaseService.getInstance().setSetting(key, value);
        return;
    }
    try {
        const encrypted = safeStorage.encryptString(value).toString('base64');
        DatabaseService.getInstance().setSetting(key, `${ENC_PREFIX}${encrypted}`);
    } catch (err: any) {
        Logger.error(`[SecureSettings] Encrypt failed for "${key}": ${err.message}`);
        // Fallback to plaintext rather than losing data
        DatabaseService.getInstance().setSetting(key, value);
    }
}

/**
 * Đọc và giải mã value từ SQLite settings.
 * Trả về null nếu không tồn tại hoặc không giải mã được.
 */
export function secureGet(key: string): string | null {
    const raw = DatabaseService.getInstance().getSetting(key);
    if (!raw) return null;

    if (raw.startsWith(ENC_PREFIX)) {
        try {
            const buf = Buffer.from(raw.slice(ENC_PREFIX.length), 'base64');
            return safeStorage.decryptString(buf);
        } catch (err: any) {
            Logger.warn(`[SecureSettings] Decrypt failed for "${key}" — may be from different machine: ${err.message}`);
            return null;
        }
    }

    // Plaintext cũ (chưa migrate) — trả về nguyên
    return raw;
}

/**
 * Xóa secure setting.
 */
export function secureDelete(key: string): void {
    DatabaseService.getInstance().setSetting(key, '');
}


