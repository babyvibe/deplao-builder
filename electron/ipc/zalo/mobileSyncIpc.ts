import { ipcMain } from 'electron';
import Logger from '../../../src/utils/Logger';
import WorkspaceManager from '../../../src/utils/app/WorkspaceManager';
import MobileSyncService from '../../../src/services/zalo/mobileSync/MobileSyncService';
import { tr } from '../../../src/shared/i18n';

/** Sync only runs on the machine that holds the Zalo connection (standalone / boss), not on an employee workspace. */
function isEmployeeMode(): boolean {
    try {
        return WorkspaceManager.getInstance().getActiveWorkspace()?.type === 'remote';
    } catch {
        return false;
    }
}

export function registerMobileSyncIpc() {
    const service = MobileSyncService.getInstance();

    // ─── Start syncing messages from the phone (time range fromTs/toTs, ms; leave empty = everything) ──
    ipcMain.handle('zalo:mobileSync:start', async (_event, { zaloId, fromTs, toTs }) => {
        try {
            if (!zaloId) return { success: false, error: tr('Thiếu tài khoản') };
            if (isEmployeeMode()) {
                return { success: false, error: tr('Chỉ chủ tài khoản (máy đang đăng nhập Zalo) mới đồng bộ được từ điện thoại') };
            }
            return await service.start(zaloId, { fromTs, toTs });
        } catch (err: any) {
            Logger.error(`[mobileSyncIpc] start error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Cancel the sync session ────────────────────────────────────────────────
    ipcMain.handle('zalo:mobileSync:cancel', async (_event, { zaloId }) => {
        try {
            return await service.cancel(zaloId);
        } catch (err: any) {
            Logger.error(`[mobileSyncIpc] cancel error: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    // ─── Status of the latest session (when the modal is reopened) ─────────────────────────
    ipcMain.handle('zalo:mobileSync:status', async (_event, { zaloId }) => {
        return { success: true, status: service.getStatus(zaloId) };
    });
}
