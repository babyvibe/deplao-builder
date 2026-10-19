import { ipcMain } from 'electron';
import Logger from '../../src/utils/Logger';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import MobileSyncService from '../../src/services/zalo/mobileSync/MobileSyncService';

/** Đồng bộ chỉ chạy ở máy giữ kết nối Zalo (standalone / boss), không chạy ở workspace nhân viên. */
function isEmployeeMode(): boolean {
    try {
        return WorkspaceManager.getInstance().getActiveWorkspace()?.type === 'remote';
    } catch {
        return false;
    }
}

export function registerMobileSyncIpc() {
    const service = MobileSyncService.getInstance();

    // ─── Bắt đầu đồng bộ tin nhắn từ điện thoại (khoảng thời gian fromTs/toTs, ms; bỏ trống = toàn bộ) ──
    ipcMain.handle('zalo:mobileSync:start', async (_event, { zaloId, fromTs, toTs }) => {
        try {
            if (!zaloId) return { success: false, error: 'Thiếu tài khoản' };
            if (isEmployeeMode()) {
                return { success: false, error: 'Chỉ chủ tài khoản (máy đang đăng nhập Zalo) mới đồng bộ được từ điện thoại' };
            }
            return await service.start(zaloId, { fromTs, toTs });
        } catch (err: any) {
            Logger.error(`[mobileSyncIpc] start error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Huỷ phiên đồng bộ ────────────────────────────────────────────────────
    ipcMain.handle('zalo:mobileSync:cancel', async (_event, { zaloId }) => {
        try {
            return await service.cancel(zaloId);
        } catch (err: any) {
            Logger.error(`[mobileSyncIpc] cancel error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Trạng thái phiên gần nhất (khi mở lại modal) ─────────────────────────
    ipcMain.handle('zalo:mobileSync:status', async (_event, { zaloId }) => {
        return { success: true, status: service.getStatus(zaloId) };
    });
}
