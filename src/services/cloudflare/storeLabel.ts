/**
 * Tên kho đang chọn cho câu báo ("R2" / "Google Drive") ở các module chỉ nhận R2Client (media, đồng bộ DB, khôi phục).
 * Đọc lúc gọi (require muộn, tránh vòng import với CloudflareService); lỗi / core giả trong test → "R2".
 */
export function storeLabelNow(): string {
    try {
        const { cloudflare } = require('./CloudflareService') as { cloudflare?: { storageProvider?: () => string } };
        return cloudflare?.storageProvider?.() === 'gdrive' ? 'Google Drive' : 'R2';
    } catch {
        return 'R2';
    }
}
