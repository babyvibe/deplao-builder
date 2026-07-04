/**
 * libraryIpc - IPC handlers cho thư viện Media (boss side).
 * Boss dùng IPC trực tiếp, employee dùng REST API.
 */

import { ipcMain } from 'electron';
import LibraryService from '../../src/services/library/LibraryService';
import DatabaseService from '../../src/services/database/DatabaseService';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';

const lib = () => LibraryService.getInstance();


function isEmployeeMode(): boolean {
    try {
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') return true;
    } catch {}
    return false;
}

export function registerLibraryIpc(): void {
  // ── Get items ──────────────────────────────────────────────
  ipcMain.handle('library:getItems', async (_event, params: {
    zaloId: string; type?: string; search?: string; folderId?: number; page?: number; limit?: number;
  }) => {
    try {

            if (isEmployeeMode()) return { success: true };
                  const result = lib().getItems({
        zaloId: params.zaloId,
        type: params.type,
        search: params.search,
        folderId: params.folderId !== undefined ? params.folderId : undefined,
        page: params.page || 1,
        limit: Math.min(params.limit || 50, 200),
      });
      return {
        success: true,
        items: result.items.map((item: any) => ({
          ...item,
          file_path: undefined,
          thumb_path: undefined,
          fileUrl: `/api/library/file/${item.uuid}`,
          thumbUrl: item.thumb_path ? `http://localhost:9900/api/library/thumb/${item.uuid}` : null,
          _localPath: item.file_path,
          _thumbLocalPath: item.thumb_path,
        })),
        total: result.total,
      };
    } catch (err: any) {
      return { success: false, error: err.message, items: [], total: 0 };
    }
  });

  // ── Upload ─────────────────────────────────────────────────
  ipcMain.handle('library:upload', async (_event, params: {
    zaloId: string; fileName: string; mimeType: string; base64: string;
    employeeId?: string; tags?: string;
  }) => {
    try {

            if (isEmployeeMode()) return { success: true };
                  const buffer = Buffer.from(params.base64, 'base64');
      const item = await lib().upload({
        zaloId: params.zaloId,
        buffer,
        fileName: params.fileName,
        mimeType: params.mimeType,
        employeeId: params.employeeId || '',
        tags: params.tags || '',
      });
      return {
        success: true,
        data: {
          ...item,
          file_path: undefined,
          thumb_path: undefined,
          fileUrl: `/api/library/file/${item.uuid}`,
          thumbUrl: item.thumb_path ? `/api/library/thumb/${item.uuid}` : null,
          _localPath: item.file_path,
          _thumbLocalPath: item.thumb_path,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Delete ─────────────────────────────────────────────────
  ipcMain.handle('library:deleteItem', async (_event, uuid: string) => {
    try {

            if (isEmployeeMode()) return { success: true };
                  lib().deleteItem(uuid);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Get folders ────────────────────────────────────────────
  ipcMain.handle('library:getFolders', async (_event, params: { zaloId: string; type?: string }) => {
    try {

            if (isEmployeeMode()) return { success: true };
                  const folders = lib().getFolders(params.zaloId, params.type);
      return { success: true, items: folders };
    } catch (err: any) {
      return { success: false, error: err.message, items: [] };
    }
  });

  // ── Create folder ──────────────────────────────────────────
  ipcMain.handle('library:createFolder', async (_event, params: {
    name: string; zaloId: string; color?: string;
  }) => {
    try {

            if (isEmployeeMode()) return { success: true };
                  const id = lib().createFolder(params);
      return { success: true, id };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Rename folder ──────────────────────────────────────────
  ipcMain.handle('library:renameFolder', async (_event, params: {
    id: number; name: string;
  }) => {
    try {

            if (isEmployeeMode()) return { success: true };
                  const db = DatabaseService.getInstance();
      db.run('UPDATE media_library_folders SET name=? WHERE id=?', [params.name, params.id]);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Delete folder ──────────────────────────────────────────
  ipcMain.handle('library:deleteFolder', async (_event, id: number) => {
    try {

            if (isEmployeeMode()) return { success: true };
                  lib().deleteFolder(id);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // ── Update item (favorite, rename, tags, etc.) ─────────────
  ipcMain.handle('library:updateItem', async (_event, params: any) => {
    try {

            if (isEmployeeMode()) return { success: true };
                  Logger.log(`[libraryIpc] updateItem: uuid=${params.uuid}, keys=${Object.keys(params).join(',')}, name=${params.name}, isFavorite=${params.isFavorite}`);
      const result = lib().updateItem(params.uuid, params);
      Logger.log(`[libraryIpc] updateItem result: ${result}`);
      return { success: result };
    } catch (err: any) {
      Logger.error(`[libraryIpc] updateItem error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  Logger.log('[libraryIpc] Registered');
}
