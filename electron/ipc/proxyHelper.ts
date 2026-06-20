import AppModeManager from '../../src/utils/AppModeManager';
import Logger from '../../src/utils/Logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Fire-and-forget proxy: send a DB/CRM mutation to the Boss when running in Employee mode.
 * The Boss executes the same IPC handler on its own DB, then relays the resulting
 * event back to all connected employees via SSE.
 *
 * In Boss / standalone mode this is a no-op.
 */
export function proxyToBoss(channel: string, params: any): void {
    try {
        if (AppModeManager.getInstance().getMode() !== 'employee') return;

        const WsMgr = require('../../src/utils/WorkspaceManager').default;
        const activeWs = WsMgr.getInstance().getActiveWorkspace();
        if (!activeWs || activeWs.type !== 'remote') return;

        const HCM = require('../../src/services/http/HttpConnectionManager').default;
        if (!HCM.getInstance().isConnected(activeWs.id)) return;

        HCM.getInstance().proxyAction(activeWs.id, channel, params).catch((err: any) => {
            Logger.warn(`[proxyToBoss] ${channel} failed: ${err.message}`);
        });
    } catch {}
}

/**
 * Upload media files from Employee machine to Boss machine.
 * Used when Employee's local file path is not valid on Boss (cross-platform paths).
 * Each file is read on Employee, sent as base64 via HTTP, saved on Boss,
 * and the Boss-resolved absolute path is returned.
 *
 * @param filePaths  - Local file paths on Employee machine
 * @param zaloId     - Zalo account ID for organizing media storage on Boss
 * @returns Boss-resolved absolute file paths (preserves order)
 */
export async function uploadEmployeeMedia(filePaths: string[], zaloId?: string): Promise<string[]> {
    if (AppModeManager.getInstance().getMode() !== 'employee') return filePaths;

    const WsMgr = require('../../src/utils/WorkspaceManager').default;
    const activeWs = WsMgr.getInstance().getActiveWorkspace();
    if (!activeWs || activeWs.type !== 'remote') throw new Error('Không kết nối tới Boss');

    const HCM = require('../../src/services/http/HttpConnectionManager').default;
    const client = HCM.getInstance().getServiceForWorkspace(activeWs.id);
    if (!client) throw new Error('Không kết nối tới Boss');

    const bossPaths: string[] = new Array(filePaths.length);

    // Upload parallel all files để giảm thời gian chờ (nhất là khi gửi nhiều ảnh)
    const uploadTasks = filePaths.map(async (fp, index) => {
        if (!fp) { bossPaths[index] = fp; return; }
        if (!fs.existsSync(fp)) {
            Logger.warn(`[uploadEmployeeMedia] File not found on Employee: ${fp}`);
            bossPaths[index] = fp;
            return;
        }
        const buffer = fs.readFileSync(fp);
        const base64 = buffer.toString('base64');
        const filename = path.basename(fp);
        try {
            const result = await client.uploadMedia(base64, filename, zaloId);
            if (result.success && result.bossPath) {
                bossPaths[index] = result.bossPath;
                Logger.log(`[uploadEmployeeMedia] ✅ ${fp} → ${result.bossPath}`);
            } else {
                throw new Error(result.error || 'Upload thất bại');
            }
        } catch (err: any) {
            throw new Error(`Không thể upload file ${fp}: ${err.message}`);
        }
    });

    await Promise.all(uploadTasks);
    return bossPaths;
}
