/**
 * secretBox.ts: encrypts secrets stored in the DB with Electron's safeStorage (DPAPI on Windows).
 * Without safeStorage (tests, before app ready) → stored as "plain:" so it still works.
 */

export function encryptSecret(secret: string): string {
    try {
        const { safeStorage } = require('electron');
        if (safeStorage?.isEncryptionAvailable?.()) return 'enc:' + safeStorage.encryptString(secret).toString('base64');
    } catch { /* test or not ready yet */ }
    return 'plain:' + secret;
}

/** Returns '' if it cannot be decrypted (machine / Windows profile changed). */
export function decryptSecret(stored: string): string {
    if (!stored) return '';
    if (stored.startsWith('plain:')) return stored.slice(6);
    if (stored.startsWith('enc:')) {
        try {
            const { safeStorage } = require('electron');
            return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
        } catch {
            return '';
        }
    }
    return stored;
}

export function isEncryptedValue(v: unknown): boolean {
    return typeof v === 'string' && (v.startsWith('enc:') || v.startsWith('plain:'));
}
