/**
 * Name of the selected store used in messages ("R2" / "Google Drive") in the modules that only accept R2Client (media, DB sync, restore).
 * Read at call time (lazy require, avoids an import cycle with CloudflareService); on error / a fake core in tests → "R2".
 */
export function storeLabelNow(): string {
    try {
        const { cloudflare } = require('./CloudflareService') as { cloudflare?: { storageProvider?: () => string } };
        return cloudflare?.storageProvider?.() === 'gdrive' ? 'Google Drive' : 'R2';
    } catch {
        return 'R2';
    }
}
