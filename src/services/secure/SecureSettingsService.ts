/**
 * SecureSettingsService.ts
 * Wrapper around electron.safeStorage to encrypt sensitive data stored in SQLite.
 * The data is encrypted by the OS (Windows Credential Manager / macOS Keychain).
 * Only this app, on this same machine, can decrypt it.
 */
import { safeStorage } from 'electron';
import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';

const ENC_PREFIX = 'enc:';

/**
 * Saves a value encrypted by safeStorage into the SQLite settings.
 */
export function secureSet(key: string, value: string): void {
    if (!value && value !== '') {
        DatabaseService.getInstance().setSetting(key, '');
        return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
        // Fallback: store plaintext with a warning (rare: the OS does not support a keychain)
        Logger.warn(`[SecureSettings] safeStorage unavailable - storing "${key}" as plaintext`);
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
 * Reads and decrypts a value from the SQLite settings.
 * Returns null if it does not exist or cannot be decrypted.
 */
export function secureGet(key: string): string | null {
    const raw = DatabaseService.getInstance().getSetting(key);
    if (!raw) return null;

    if (raw.startsWith(ENC_PREFIX)) {
        try {
            const buf = Buffer.from(raw.slice(ENC_PREFIX.length), 'base64');
            return safeStorage.decryptString(buf);
        } catch (err: any) {
            Logger.warn(`[SecureSettings] Decrypt failed for "${key}" - may be from different machine: ${err.message}`);
            return null;
        }
    }

    // Old plaintext (not migrated yet): returned as is
    return raw;
}

/**
 * Deletes a secure setting.
 */
export function secureDelete(key: string): void {
    DatabaseService.getInstance().setSetting(key, '');
}

/**
 * Saves a value with mandatory encryption. NO plaintext fallback.
 * Used for E2EE device state: if safeStorage is unavailable → throws an error.
 * The caller must handle it and degrade the service (without saving state).
 */
export function secureSetRequired(key: string, value: string): void {
    if (!value && value !== '') {
        DatabaseService.getInstance().setSetting(key, '');
        return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(`[SecureSettings] safeStorage unavailable — cannot encrypt ${key} (E2EE state requires encryption)`);
    }
    try {
        const encrypted = safeStorage.encryptString(value).toString('base64');
        DatabaseService.getInstance().setSetting(key, `${ENC_PREFIX}${encrypted}`);
    } catch (err: any) {
        throw new Error(`[SecureSettings] Encrypt failed for ${key}: ${err.message}`);
    }
}


