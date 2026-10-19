/**
 * restoreGate — sau khi khôi phục DB từ R2 (máy mới / máy dự phòng), mọi tự động hoá có thể gửi tin
 * (chiến dịch CRM, workflow, lịch của ứng dụng) phải chờ người dùng xác nhận máy cũ đã tắt (bước 6 của
 * trình khôi phục) — tránh hai máy cùng gửi một chiến dịch.
 *
 * Cờ nằm trong app_settings của workspace (Restore ghi vào file đã khôi phục trước khi thay DB):
 *  - 'cloud_restore_paused_automations' = '1' → tạm dừng tự động hoá.
 *  - 'cloud_restore_pending_relogin'    = '1' → còn kênh cần đăng nhập lại (chỉ để giao diện nhắc).
 *
 * Đọc cờ rẻ (một SELECT theo khoá chính, nhớ 5 s, đổi workspace là đọc lại) nên gọi được ở đường nóng.
 */
import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';

export const RESTORE_PAUSED_KEY = 'cloud_restore_paused_automations';
export const RESTORE_RELOGIN_KEY = 'cloud_restore_pending_relogin';

const CACHE_MS = 5000;
let cache: { value: boolean; at: number; dbPath: string } | null = null;

/** true khi workspace đang mở vừa được khôi phục và người dùng chưa bật lại tự động hoá. */
export function automationsPausedAfterRestore(): boolean {
    try {
        const db = DatabaseService.getInstance();
        const dbPath = db.getDbPath();
        const now = Date.now();
        if (cache && cache.dbPath === dbPath && now - cache.at < CACHE_MS) return cache.value;
        const value = db.getSetting(RESTORE_PAUSED_KEY) === '1';
        cache = { value, at: now, dbPath };
        return value;
    } catch {
        return false;
    }
}

export function restorePendingRelogin(): boolean {
    try {
        return DatabaseService.getInstance().getSetting(RESTORE_RELOGIN_KEY) === '1';
    } catch {
        return false;
    }
}

/** Bước 6 của trình khôi phục: người dùng xác nhận máy cũ đã tắt → bỏ cờ và chạy lại chiến dịch đang dở. */
export function resumeAutomationsAfterRestore(): void {
    const db = DatabaseService.getInstance();
    db.setSetting(RESTORE_PAUSED_KEY, '0');
    db.setSetting(RESTORE_RELOGIN_KEY, '0');
    cache = null;
    try {
        // require lười: tránh vòng import CRMQueueService ↔ DatabaseService lúc khởi động.
        const CRMQueueService = require('../crm/CRMQueueService').default;
        CRMQueueService.getInstance().resumeActiveCampaigns();
    } catch (err: any) {
        Logger.warn(`[restoreGate] resume campaigns: ${err?.message || err}`);
    }
    Logger.log('[restoreGate] Automations resumed after restore');
}

/** Gọi khi DB được thay/đổi workspace để lần đọc sau lấy giá trị mới ngay. */
export function invalidateRestoreGate(): void {
    cache = null;
}
