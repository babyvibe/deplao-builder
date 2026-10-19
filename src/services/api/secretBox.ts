/**
 * secretBox.ts — mã hoá bí mật lưu trong DB bằng safeStorage của Electron (DPAPI trên Windows).
 * Không có safeStorage (test, trước app ready) → lưu dạng "plain:" để vẫn chạy được.
 */

export function encryptSecret(secret: string): string {
    try {
        const { safeStorage } = require('electron');
        if (safeStorage?.isEncryptionAvailable?.()) return 'enc:' + safeStorage.encryptString(secret).toString('base64');
    } catch { /* test hoặc chưa sẵn sàng */ }
    return 'plain:' + secret;
}

/** Trả '' nếu không giải mã được (đổi máy / hồ sơ Windows). */
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
