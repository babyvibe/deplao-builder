/**
 * pluginIpc — IPC cho trang Ứng dụng, API & Webhook (cài, bật/tắt, cài đặt, nhật ký plugin) và cầu iframe của UI plugin.
 *
 * Mọi kênh dùng tiền tố "plugins:" → IpcInvoker chặn với principal không phải 'system'
 * (API key / plugin không tự cài, bật, đổi quyền plugin được).
 * plugins:invoke nhận pluginId từ renderer (PluginFrame biết iframe nào gửi), không tin message.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import Logger from '../../src/utils/Logger';
import { ApiError } from '../../src/services/api/types';
import PluginsPlatform from '../../src/services/plugins/PluginsPlatform';
import PluginNodeRegistry from '../../src/services/plugins/PluginNodeRegistry';

function fail(err: any): { success: false; error: string; code?: string; status?: number; details?: any } {
    if (err instanceof ApiError) return { success: false, error: err.message, code: err.code, status: err.status, details: err.details };
    return { success: false, error: err?.message || String(err), code: err?.code };
}

function platform(): PluginsPlatform {
    return PluginsPlatform.getInstance();
}

function isEmployeeMachine(): boolean {
    try {
        return require('../../src/utils/AppModeManager').default.getInstance().getMode() === 'employee';
    } catch {
        return false;
    }
}

function guardMachine(): void {
    if (isEmployeeMachine()) throw new ApiError(409, 'CONFLICT', 'Máy nhân viên không chạy ứng dụng mở rộng');
    const { isWorkspaceAvailable } = require('../../src/services/api/runtime');
    if (!isWorkspaceAvailable()) throw new ApiError(409, 'CONFLICT', 'Workspace từ xa không chạy ứng dụng mở rộng; hãy mở workspace trên máy này');
}

const senderHooked = new WeakSet<Electron.WebContents>();

export function registerPluginIpc(): void {
    ipcMain.handle('plugins:list', async () => {
        try {
            const p = platform();
            return { success: true, plugins: p.manager.list(), contributions: p.contributions() };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:contributions', async () => {
        try {
            return { success: true, contributions: platform().contributions() };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:pickZip', async e => {
        try {
            guardMachine();
            const win = BrowserWindow.fromWebContents(e.sender) || undefined;
            const res = await dialog.showOpenDialog(win as any, {
                title: 'Chọn gói ứng dụng (.zip)',
                filters: [{ name: 'Plugin Deplao', extensions: ['zip'] }],
                properties: ['openFile'],
            });
            if (res.canceled || !res.filePaths[0]) return { success: true, canceled: true };
            return { success: true, preview: platform().manager.inspectZip(res.filePaths[0]) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:inspectZip', async (_e, { path }: { path: string }) => {
        try {
            guardMachine();
            if (!path || !/\.zip$/i.test(path) || !fs.existsSync(path)) return { success: false, error: 'Chọn file .zip của ứng dụng' };
            return { success: true, preview: platform().manager.inspectZip(path) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:pickDevFolder', async e => {
        try {
            guardMachine();
            const win = BrowserWindow.fromWebContents(e.sender) || undefined;
            const res = await dialog.showOpenDialog(win as any, { title: 'Chọn thư mục ứng dụng đang phát triển', properties: ['openDirectory'] });
            if (res.canceled || !res.filePaths[0]) return { success: true, canceled: true };
            return { success: true, preview: platform().manager.inspectDevFolder(res.filePaths[0]) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:confirmInstall', async (_e, { token, accountIds }: { token: string; accountIds?: string[] | null }) => {
        try {
            guardMachine();
            const res = await platform().manager.confirmInstall(String(token || ''), { accountIds: accountIds === undefined ? undefined : accountIds });
            Logger.log(`[pluginIpc] installed ${res.record.id}@${res.record.version} (${res.record.status})`);
            return { success: true, record: res.record, remoteCredentials: res.remoteCredentials || null };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:cancelInstall', async (_e, { token }: { token: string }) => {
        try {
            platform().manager.cancelInstall(String(token || ''));
            return { success: true };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:enable', async (_e, { id }: { id: string }) => {
        try {
            guardMachine();
            return { success: true, record: await platform().manager.enable(String(id)) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:disable', async (_e, { id }: { id: string }) => {
        try {
            return { success: true, record: await platform().manager.disable(String(id)) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:reload', async (_e, { id }: { id: string }) => {
        try {
            guardMachine();
            return { success: true, record: await platform().manager.reload(String(id)) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:uninstall', async (_e, { id, deleteData }: { id: string; deleteData?: boolean }) => {
        try {
            await platform().manager.uninstall(String(id), { deleteData: !!deleteData });
            Logger.log(`[pluginIpc] uninstalled ${id} (deleteData=${!!deleteData})`);
            return { success: true };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:getSettings', async (_e, { id }: { id: string }) => {
        try {
            return { success: true, ...platform().manager.getSettings(String(id)) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:setSettings', async (_e, { id, values }: { id: string; values: Record<string, any> }) => {
        try {
            return { success: true, values: await platform().manager.setSettings(String(id), values || {}) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:logs', async (_e, { id, limit }: { id: string; limit?: number }) => {
        try {
            return { success: true, logs: platform().manager.logs.list(String(id), limit || 500) };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:openFolder', async (_e, { id, kind }: { id: string; kind?: 'code' | 'data' }) => {
        try {
            const m = platform().manager;
            const rec = m.get(String(id));
            if (!rec) return { success: false, error: 'Không có ứng dụng này' };
            const dir = kind === 'data' ? m.storage.dataDir(rec.id) : rec.install_path;
            const err = await shell.openPath(dir);
            return err ? { success: false, error: err } : { success: true };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:nodeTypes', async () => {
        try {
            return { success: true, nodes: PluginNodeRegistry.getInstance().list() };
        } catch (err) {
            return fail(err);
        }
    });

    // ─── Cầu iframe UI plugin ───────────────────────────────────────────

    ipcMain.handle('plugins:invoke', async (_e, { pluginId, method, params }: { pluginId: string; method: string; params?: any }) => {
        try {
            const result = await platform().bridge.handle(String(pluginId), String(method), params, 'ui');
            return { success: true, result };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:events:subscribe', async (e, { pluginId, types }: { pluginId: string; types?: string[] }) => {
        try {
            const sender = e.sender;
            const key = String(sender.id);
            if (!senderHooked.has(sender)) {
                senderHooked.add(sender);
                sender.once('destroyed', () => platform().unsubscribeUi(key));
            }
            platform().subscribeUi(key, String(pluginId), Array.isArray(types) ? types.map(String) : null, ev => {
                if (!sender.isDestroyed()) sender.send('plugins:event', { pluginId, event: ev });
            });
            return { success: true };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:events:unsubscribe', async (e, { pluginId }: { pluginId?: string } = {}) => {
        try {
            platform().unsubscribeUi(String(e.sender.id), pluginId ? String(pluginId) : undefined);
            return { success: true };
        } catch (err) {
            return fail(err);
        }
    });

    ipcMain.handle('plugins:command', async (_e, { pluginId, buttonId, context }: { pluginId: string; buttonId: string; context?: any }) => {
        try {
            return { success: true, result: await platform().composerCommand(String(pluginId), String(buttonId), context || {}) };
        } catch (err) {
            return fail(err);
        }
    });
}
