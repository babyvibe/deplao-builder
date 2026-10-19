import { ipcMain, app, dialog } from 'electron';
import DatabaseService from '../../src/services/database/DatabaseService';
import FileStorageService from '../../src/services/file/FileStorageService';
import WorkflowEngineService from '../../src/services/workflow/WorkflowEngineService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import MediaCacheService from '../../src/services/cache/MediaCacheService';
import { proxyToBoss, proxyToBossWithResult } from './proxyHelper';
import Logger from '../../src/utils/Logger';
import * as path from 'path';
import * as fs from 'fs';
import AppModeManager from '../../src/utils/AppModeManager';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import { clampMediaPageLimit, normalizeMediaCursor } from '../../src/services/database/mediaMessagesQuery';
import { contactAliasChanged, contactProfileChanged } from '../../src/services/database/contactProfileChange';

function isEmployeeMode(): boolean {
    try {
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') return true;
    } catch {}
    return false;
}

/**
 * Tạm dừng đồng bộ DB lên Cloudflare quanh thao tác thay file DB (dbsync nhả file trước, kiểm tra lại DB sau).
 * Không nạp được module (hoặc đồng bộ đang tắt) → chạy thẳng.
 */
function withCloudDbPaused<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    let cloudDb: { pauseFor<R>(reason: string, fn: () => Promise<R> | R): Promise<R> } | null = null;
    try {
        cloudDb = (require('../../src/services/cloudflare/dbsync') as typeof import('../../src/services/cloudflare/dbsync')).cloudDb;
    } catch {
        cloudDb = null;
    }
    return cloudDb ? cloudDb.pauseFor(reason, fn) : fn();
}

// Copy toàn bộ thư mục src → dest (async, recursive).
// opts.overwrite=true → ghi đè file đã tồn tại; opts.onFile → progress callback.
// Yield to event-loop every 20 files so IPC progress events can be delivered.
async function copyDirRecursive(
    src: string,
    dest: string,
    opts?: { overwrite?: boolean; onFile?: (count: number) => void },
    _counter = { n: 0 },
): Promise<number> {
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDirRecursive(srcPath, destPath, opts, _counter);
        } else {
            const exists = !opts?.overwrite && await fs.promises.access(destPath).then(() => true).catch(() => false);
            if (!exists) {
                await fs.promises.copyFile(srcPath, destPath);
                _counter.n++;
                opts?.onFile?.(_counter.n);
                // Yield every 20 files → cho phép IPC events được gửi đi
                if (_counter.n % 20 === 0) {
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
            }
        }
    }
    return _counter.n;
}

// Đếm tổng số file trong thư mục (recursive) - dùng để hiện tiến trình X / Y.
async function countFiles(dir: string): Promise<number> {
    let count = 0;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            count += await countFiles(path.join(dir, entry.name));
        } else {
            count++;
        }
    }
    return count;
}

export function registerDatabaseIpc() {
    ipcMain.handle('db:getMessages', async (_event, { zaloId, threadId, limit = 50, offset = 0, before = 0, topicId }: { zaloId: string; threadId: string; limit?: number; offset?: number; before?: number; topicId?: string }) => {
        try {
            const _isEmp = isEmployeeMode();
            if (_isEmp) {
                Logger.warn(`[databaseIpc] db:getMessages BLOCKED by employee mode (activeWs=${WorkspaceManager.getInstance().getActiveWorkspace()?.type || 'none'})`);
                return { success: true };
            }
            // Renderer input is not a safe pagination boundary.  A malformed or
            // legacy caller must not serialize an entire multi-million-row thread
            // over IPC and freeze both Electron processes.
            const safeLimit = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 200);
            const safeOffset = Math.max(Math.floor(Number(offset) || 0), 0);
            const safeBefore = Math.max(Math.floor(Number(before) || 0), 0);
            const messages = DatabaseService.getInstance().getMessages(zaloId, threadId, safeLimit, safeOffset, safeBefore || undefined, topicId);
            Logger.log(`[databaseIpc] db:getMessages → ${messages.length} msgs (limit=${safeLimit}, cursor=${safeBefore || '-'}, offset=${safeOffset})`);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getMessagesAround', async (_event, { zaloId, threadId, timestamp, limit = 50 }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const messages = DatabaseService.getInstance().getMessagesAround(zaloId, threadId, timestamp, limit);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveAccount', async (_event, account: any) => {
        try {
            DatabaseService.getInstance().saveAccount(account);
            return { success: true };
        } catch (error: any) {
            Logger.error(`[db:saveAccount] ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getContacts', async (_event, { zaloId }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const contacts = DatabaseService.getInstance().getContacts(zaloId);
            return { success: true, contacts };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getContactById', async (_event, { zaloId, contactId }: { zaloId: string; contactId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true, contact: null };
            const contact = DatabaseService.getInstance().getContactById(zaloId, String(contactId));
            return { success: true, contact: contact || null };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getContactsFiltered', async (_event, params: { zaloId: string; channel?: string; search?: string; othersOnly?: boolean; excludeOthers?: boolean; unreadOnly?: boolean; contactIds?: string[]; limit?: number; offset?: number }) => {
        try {
            if (isEmployeeMode()) return { success: true, contacts: [] };
            const contacts = DatabaseService.getInstance().getContactsFiltered(params.zaloId, params);
            return { success: true, contacts };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:searchContactsForPicker', async (_event, params: { zaloId: string; search?: string; type?: 'user' | 'group' | 'all'; limit?: number; offset?: number; ids?: string[] }) => {
        const empty = { items: [], total: 0, counts: { all: 0, user: 0, group: 0 } };
        try {
            if (isEmployeeMode()) return { success: true, ...empty };
            return { success: true, ...DatabaseService.getInstance().searchContactsForPicker(params.zaloId, params) };
        } catch (error: any) {
            return { success: false, error: error.message, ...empty };
        }
    });

    ipcMain.handle('db:searchContactByPhone', async (_event, { zaloId, phone }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const contact = DatabaseService.getInstance().searchContactByPhone(zaloId, phone);
            return { success: true, contact: contact || null };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:searchMessages', async (_event, { zaloId, query }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const results = DatabaseService.getInstance().searchMessages(zaloId, query);
            return { success: true, results };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getMediaMessages', async (_event, { zaloId, threadId, limit, offset, beforeTs, beforeMsgId, afterTs, afterMsgId }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            if (!threadId) return { success: true, messages: DatabaseService.getInstance().getAllLocalMediaMessages(zaloId) };
            // beforeTs/afterTs (+ msgId): keyset page on (timestamp, msg_id) for the image viewer gallery, newest-first.
            // No cursor → the old offset paging (panel Ảnh/Video, Public API), unchanged.
            const cursor = normalizeMediaCursor({ beforeTs, beforeMsgId, afterTs, afterMsgId });
            const messages = cursor
                ? DatabaseService.getInstance().getMediaMessages(zaloId, threadId, clampMediaPageLimit(limit), 0, cursor)
                : DatabaseService.getInstance().getMediaMessages(zaloId, threadId, limit ?? 50, offset ?? 0);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getFileMessages', async (_event, { zaloId, threadId, limit, offset }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const messages = DatabaseService.getInstance().getFileMessages(zaloId, threadId, limit ?? 50, offset ?? 0);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getUnreadCount', async (_event, { zaloId }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const total = DatabaseService.getInstance().getTotalUnread(zaloId);
            return { success: true, total };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Ghi trên Boss (UI Boss, proxy / REST của nhân viên) phát event như lệnh REST tương ứng → UI Boss + nhân viên được
    // giao tài khoản cập nhật ngay. Nhân viên (isEmployeeMode) không phát: Boss phát sau khi ghi và relay về.
    ipcMain.handle('db:markAsRead', async (_event, { zaloId, contactId }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:markAsRead', { zaloId, contactId });
            DatabaseService.getInstance().markAsRead(zaloId, contactId);
            // Đã đọc là dữ liệu chung → máy khác xoá số chưa đọc (trước đây Boss đọc không xoá được số của nhân viên)
            if (!isEmployeeMode()) EventBroadcaster.emit('db:unreadChanged', { zaloId, contactId, unread: 0 });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:markMessageRecalled', async (_event, { zaloId, msgId, threadId }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:markMessageRecalled', { zaloId, msgId, threadId });
            // threadId: msg_id Telegram chỉ duy nhất trong 1 hội thoại (xem DatabaseService.messageIdScope)
            DatabaseService.getInstance().markMessageRecalled(zaloId, msgId, threadId ? String(threadId) : undefined);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:deleteMessages', async (_event, { zaloId, msgIds, threadId }: { zaloId: string; msgIds: string[]; threadId?: string }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:deleteMessages', { zaloId, msgIds, threadId });
            DatabaseService.getInstance().deleteMessages(zaloId, msgIds, threadId ? String(threadId) : undefined);
            // Xoá khỏi app: máy khác bỏ tin khỏi khung chat (cùng event lệnh REST messages/delete vẫn phát).
            // scope 'app' ≠ chat.delete của Zalo (tin vẫn giữ, hiện "đã thu hồi"): bên nhận XOÁ tin, không đánh dấu thu hồi.
            if (!isEmployeeMode() && Array.isArray(msgIds) && msgIds.length > 0) {
                EventBroadcaster.emit('event:delete', { zaloId, msgIds, scope: 'app', ...(threadId ? { threadId: String(threadId) } : {}) });
            }
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:updateContactProfile', async (_event, { zaloId, contactId, displayName, avatarUrl, phone, contactType, gender, birthday, isBot, manualDetails }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:updateContactProfile', { zaloId, contactId, displayName, avatarUrl, phone, contactType, gender, birthday, isBot, manualDetails });
            const db = DatabaseService.getInstance();
            // Boss gọi cho gần như mọi tin nhắn đến → chỉ phát event khi hồ sơ THẬT SỰ đổi (so bản ghi trước / sau)
            const emit = !isEmployeeMode() && !!contactId;
            const before = emit ? db.getContactById(zaloId, String(contactId)) : undefined;
            db.updateContactProfile(zaloId, contactId, displayName || '', avatarUrl || '', phone || '', contactType || '', gender ?? null, birthday ?? null, isBot ?? null, Boolean(manualDetails));
            if (emit) {
                const after: any = db.getContactById(zaloId, String(contactId));
                if (contactProfileChanged(before as any, after)) {
                    EventBroadcaster.emit('db:contactProfileUpdated', {
                        ownerZaloId: zaloId, contactId: String(contactId),
                        displayName: after.display_name, avatarUrl: after.avatar_url, phone: after.phone,
                        gender: after.gender, birthday: after.birthday,
                    });
                }
            }
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:updateAccountPhone', async (_event, { zaloId, phone }: { zaloId: string; phone: string }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:updateAccountPhone', { zaloId, phone });
            DatabaseService.getInstance().updateAccountPhone(zaloId, phone);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:updateReaction', async (_event, { zaloId, msgId, userId, icon, emoji, threadId }) => {
        try {
            const iconValue = icon || emoji || '';
            // threadId: chỉ sửa tin của đúng hội thoại (msg_id có thể trùng giữa các hội thoại)
            if (isEmployeeMode()) proxyToBoss('db:updateReaction', { zaloId, msgId, userId, icon: iconValue, threadId });
            DatabaseService.getInstance().updateMessageReaction(zaloId, String(msgId), userId, iconValue, threadId ? String(threadId) : undefined);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:updateLocalPaths', async (_event, { zaloId, msgId, localPaths }) => {
        try {
            DatabaseService.getInstance().updateLocalPaths(zaloId, String(msgId), localPaths || {});
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getMessageById', async (_event, { zaloId, msgId, threadId }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const message = DatabaseService.getInstance().getMessageById(zaloId, String(msgId), threadId);
            return { success: true, message: message || null };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getMessagesByIds', async (_event, { zaloId, msgIds }) => {
        try {
            if (isEmployeeMode()) return { success: true, messages: [] };
            const messages = DatabaseService.getInstance().getMessagesByIds(zaloId, (msgIds || []).map(String));
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Storage path management ──────────────────────────────────────────
    ipcMain.handle('db:getStoragePath', async () => {
        try {
            if (isEmployeeMode()) {
                // Employee mode: trả về thông tin local của Employee (không phải Boss)
                const userDataPath = app.getPath('userData');
                const cache = MediaCacheService.getInstance();
                const cacheDir = cache['cacheDir'] || path.join(app.getPath('userData'), '.media-cache');
                let cacheSize = 0;
                try {
                    const index = cache['index'] as Map<string, any> | undefined;
                    if (index) {
                        for (const entry of index.values()) {
                            cacheSize += entry.size || 0;
                        }
                    }
                } catch {}
                return {
                    success: true,
                    path: userDataPath,
                    defaultPath: userDataPath,
                    isEmployee: true,
                    mediaCachePath: cacheDir,
                    mediaCacheSize: cacheSize,
                };
            }
            const userDataPath = app.getPath('userData');
            const configPath = path.join(userDataPath, 'deplao-config.json');
            let customPath: string | null = null;
            if (fs.existsSync(configPath)) {
                try {
                    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    customPath = cfg.dbFolder || null;
                } catch {}
            }
            const currentPath = customPath || userDataPath;
            const actualDbPath = DatabaseService.getInstance().getDbPath();
            return {
                success: true,
                path: currentPath,
                defaultPath: userDataPath,
                configPath,
                actualDbPath,
                configExists: fs.existsSync(configPath),
                isEmployee: false,
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:setStoragePath', async (event, { newFolder, useExisting }: { newFolder: string; useExisting?: boolean }) => withCloudDbPaused('storage-path', async () => {
        try {
            if (!fs.existsSync(newFolder)) {
                fs.mkdirSync(newFolder, { recursive: true });
            }

            const configPath = path.join(app.getPath('userData'), 'deplao-config.json');
            const oldDbPath = DatabaseService.getInstance().getDbPath();
            const newDbPath = path.join(newFolder, 'deplao-tool.db');

            if (oldDbPath === newDbPath) {
                return { success: true, newPath: newDbPath, message: 'Thư mục không thay đổi.' };
            }

            if (useExisting) {
                // ── Chế độ "dùng dữ liệu cũ": chỉ cập nhật config, không copy ──────────
                let cfg: any = {};
                if (fs.existsSync(configPath)) {
                    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
                }
                cfg.dbFolder = newFolder;
                fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
                await DatabaseService.getInstance().reinitialize();
                FileStorageService.resetBaseDir();

                // Convert ALL absolute local_paths → relative (folder-agnostic).
                // Works for any old base dir - no need to rewriteLocalPaths first.
                try {
                    const migrated = DatabaseService.getInstance().migrateAllAbsolutePathsToRelative();
                    if (migrated > 0) {
                        DatabaseService.getInstance().forceFlush();
                        console.log(`[databaseIpc] useExisting: migrated ${migrated} messages to relative paths`);
                    }
                } catch {}

                return { success: true, newPath: newDbPath, message: 'Đã chuyển sang dữ liệu cũ thành công.' };
            }

            // ── Bước 1: Force flush in-memory DB → disk ───────────────────────────────
            DatabaseService.getInstance().forceFlush();

            // ── Bước 2: Copy DB file ──────────────────────────────────────────────────
            if (oldDbPath && fs.existsSync(oldDbPath)) {
                fs.copyFileSync(oldDbPath, newDbPath);
            }

            // ── Bước 3: Copy media folder ─────────────────────────────────────────────
            // Tính oldMediaDir trực tiếp từ vị trí DB cũ (tránh dùng cache của FileStorageService)
            const oldMediaDir = path.join(path.dirname(oldDbPath), 'media');
            const newMediaDir = path.join(newFolder, 'media');
            let mediaCopied = 0;
            let mediaTotal = 0;
            let mediaError: string | undefined;

            if (oldMediaDir !== newMediaDir && fs.existsSync(oldMediaDir)) {
                // Đếm trước tổng số file để UI hiển thị tiến trình X/Y
                try {
                    mediaTotal = await countFiles(oldMediaDir);
                    try { event.sender.send('db:copyProgress', { copied: 0, total: mediaTotal }); } catch {}
                } catch {}

                try {
                    mediaCopied = await copyDirRecursive(oldMediaDir, newMediaDir, {
                        overwrite: true,
                        onFile: (count) => {
                            try { event.sender.send('db:copyProgress', { copied: count, total: mediaTotal }); } catch {}
                        },
                    });
                    // Emit hoàn tất
                    try { event.sender.send('db:copyProgress', { copied: mediaCopied, total: mediaTotal, done: true }); } catch {}
                } catch (copyErr: any) {
                    mediaError = copyErr.message;
                    console.error(`[databaseIpc] Media copy error: ${copyErr.message}`);
                }
            }

            // ── Bước 4: Lưu config ────────────────────────────────────────────────────
            let cfg: any = {};
            if (fs.existsSync(configPath)) {
                try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
            }
            cfg.dbFolder = newFolder;
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');

            // ── Bước 5: Reinitialize DatabaseService từ path mới ─────────────────────
            await DatabaseService.getInstance().reinitialize();

            // ── Bước 6: Reset FileStorageService cache ────────────────────────────────
            FileStorageService.resetBaseDir();

            // ── Bước 7: Cập nhật local_paths trong DB sang đường dẫn mới ─────────────
            // Chạy ngay cả khi media copy có lỗi một phần (mediaError set) - DB đã được
            // copy xong nên paths cần được rewrite để trỏ đúng vào vị trí mới.
            let pathsRewritten = 0;
            if (oldMediaDir !== newMediaDir) {
                try {
                    pathsRewritten = DatabaseService.getInstance().rewriteLocalPaths(oldMediaDir, newMediaDir);
                } catch (rewriteErr: any) {
                    console.error(`[databaseIpc] rewriteLocalPaths error: ${rewriteErr.message}`);
                }
            }

            // ── Bước 8: Chuyển tất cả absolute paths còn lại sang relative ────────────
            // Sau bước 7, mọi path từ oldMediaDir đã được rewrite sang newMediaDir.
            // Bước này parse JSON đúng cách và convert BẤT KỲ absolute path nào còn lại
            // (kể cả path từ các lần đổi folder cũ hơn) → relative, folder-agnostic.
            let pathsMigrated = 0;
            try {
                pathsMigrated = DatabaseService.getInstance().migrateAllAbsolutePathsToRelative();
            } catch (migrateErr: any) {
                console.error(`[databaseIpc] migrateAllAbsolutePathsToRelative error: ${migrateErr.message}`);
            }

            if (pathsRewritten > 0 || pathsMigrated > 0) {
                DatabaseService.getInstance().forceFlush();
            }

            const message = mediaCopied > 0
                ? `Đã sao chép DB + ${mediaCopied.toLocaleString()} file media thành công.`
                : 'Đã thay đổi thư mục lưu trữ thành công.';

            return { success: true, newPath: newDbPath, message, mediaCopied, mediaError, pathsRewritten, pathsMigrated };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }));

    ipcMain.handle('db:selectStorageFolder', async () => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openDirectory', 'createDirectory'],
                title: 'Chọn thư mục lưu trữ dữ liệu',
            });
            if (result.canceled || !result.filePaths.length) {
                return { success: true, canceled: true };
            }
            const folder = result.filePaths[0];
            const dbFilePath = path.join(folder, 'deplao-tool.db');
            const hasExistingData = fs.existsSync(dbFilePath);
            return { success: true, canceled: false, folder, hasExistingData };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Friend Cache ─────────────────────────────────────────────────────
    ipcMain.handle('db:isFriend', async (_event, { zaloId, userId }: { zaloId: string; userId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const isFriend = DatabaseService.getInstance().checkIsFriend(zaloId, userId);
            return { success: true, isFriend };
        } catch (error: any) {
            return { success: false, isFriend: false, error: error.message };
        }
    });

    ipcMain.handle('db:getFriends', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const friends = DatabaseService.getInstance().getFriends(zaloId);
            const lastFetched = DatabaseService.getInstance().getFriendsLastFetched(zaloId);
            return { success: true, friends, lastFetched };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveFriends', async (_event, { zaloId, friends }: { zaloId: string; friends: any[] }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:saveFriends', { zaloId, friends });
            DatabaseService.getInstance().saveFriends(zaloId, friends);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:deleteConversation', async (_event, { zaloId, contactId }: { zaloId: string; contactId: string }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:deleteConversation', { zaloId, contactId });
            DatabaseService.getInstance().deleteConversation(zaloId, contactId);
            // Máy khác bỏ hội thoại khỏi danh sách (trước đây chỉ lệnh REST phát, Boss xoá thì nhân viên không biết)
            if (!isEmployeeMode()) EventBroadcaster.emit('db:conversationDeleted', { ownerZaloId: zaloId, contactId, threadId: contactId });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getLinks', async (_event, { zaloId, threadId, limit, offset }: { zaloId: string; threadId: string; limit?: number; offset?: number }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const links = DatabaseService.getInstance().getLinks(zaloId, threadId, limit ?? 50, offset ?? 0);
            return { success: true, links };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveLink', async (_event, { zaloId, threadId, msgId, url, title, domain, thumbUrl, timestamp }: any) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:saveLink', { zaloId, threadId, msgId, url, title, domain, thumbUrl, timestamp });
            DatabaseService.getInstance().saveLink(zaloId, threadId, msgId, url || '', title || '', domain || '', thumbUrl || '', timestamp || Date.now());
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Group Member Cache ───────────────────────────────────────────────
    ipcMain.handle('db:getGroupMembers', async (_event, { zaloId, groupId }: { zaloId: string; groupId: string }) => {
        try {
            const members = DatabaseService.getInstance().getGroupMembers(zaloId, groupId);
            return { success: true, members };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Panel "Thành viên" của khung chat: phân trang + tìm trong DB (không tải cả nhóm vài nghìn người một lần)
    ipcMain.handle('db:getGroupMembersPage', async (_event, params: { zaloId: string; groupId: string; query?: string; limit?: number; offset?: number; ownerRole?: number }) => {
        try {
            const { zaloId, groupId, query, limit, offset, ownerRole } = params || ({} as any);
            const page = DatabaseService.getInstance().getGroupMembersPage(zaloId, groupId, { query, limit, offset, ownerRole });
            return { success: true, ...page };
        } catch (error: any) {
            return { success: false, error: error.message, members: [], total: 0 };
        }
    });

    ipcMain.handle('db:getAllGroupMembers', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            const rows = DatabaseService.getInstance().getAllGroupMembers(zaloId);
            return { success: true, rows };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveGroupMembers', async (_event, { zaloId, groupId, members }: { zaloId: string; groupId: string; members: any[] }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:saveGroupMembers', { zaloId, groupId, members });
            DatabaseService.getInstance().saveGroupMembers(zaloId, groupId, members);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:upsertGroupMember', async (_event, { zaloId, groupId, member }: { zaloId: string; groupId: string; member: any }) => {
        try {
            // Tên kênh phải có tiền tố db: — trước đây gửi "upsertGroupMember" → Boss không có handler, không bao giờ ghi
            if (isEmployeeMode()) proxyToBoss('db:upsertGroupMember', { zaloId, groupId, member });
            DatabaseService.getInstance().upsertGroupMember(zaloId, groupId, member);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:removeGroupMember', async (_event, { zaloId, groupId, memberId }: { zaloId: string; groupId: string; memberId: string }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:removeGroupMember', { zaloId, groupId, memberId });
            DatabaseService.getInstance().removeGroupMember(zaloId, groupId, memberId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Sticker Cache ────────────────────────────────────────────────

    // ─── Sticker Cache ────────────────────────────────────────────────────
    ipcMain.handle('db:saveStickers', async (_event, { stickers }: { stickers: any[] }) => {
        try {
            // Cache sticker dùng chung trên Boss (không theo tài khoản) — đọc sticker của nhân viên đi REST tới Boss
            if (isEmployeeMode()) proxyToBoss('db:saveStickers', { stickers });
            DatabaseService.getInstance().saveStickers(stickers || []);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getStickerById', async (_event, { stickerId }: { stickerId: number }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const sticker = DatabaseService.getInstance().getStickerById(stickerId);
            return { success: true, sticker: sticker || null };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getRecentStickers', async (_event, params: any) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const limit = params?.limit ?? 30;
            const stickers = DatabaseService.getInstance().getRecentStickers(limit);
            return { success: true, stickers };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:addRecentSticker', async (_event, { stickerId }: { stickerId: number }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:addRecentSticker', { stickerId });
            DatabaseService.getInstance().addRecentSticker(stickerId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:markStickerUnsupported', async (_event, { stickerId }: { stickerId: number }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:markStickerUnsupported', { stickerId });
            DatabaseService.getInstance().markStickerUnsupported(stickerId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveStickerPacks', async (_event, { packs }: { packs: any[] }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:saveStickerPacks', { packs });
            DatabaseService.getInstance().saveStickerPacks(packs || []);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getStickerPacks', async () => {
        try {
            if (isEmployeeMode()) return { success: true };
            const packs = DatabaseService.getInstance().getStickerPacks();
            return { success: true, packs };
        } catch (error: any) {
            return { success: false, error: error.message, packs: [] };
        }
    });

    ipcMain.handle('db:getStickersByPackId', async (_event, { catId }: { catId: number }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const stickers = DatabaseService.getInstance().getStickersByPackId(catId);
            return { success: true, stickers };
        } catch (error: any) {
            return { success: false, error: error.message, stickers: [] };
        }
    });

    // ─── Keyword Stickers Cache ─────────────────────────────────────────

    ipcMain.handle('db:saveKeywordStickers', async (_event, { keyword, stickerIds }: { keyword: string; stickerIds: number[] }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:saveKeywordStickers', { keyword, stickerIds });
            DatabaseService.getInstance().saveKeywordStickers(keyword, stickerIds);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getKeywordStickers', async (_event, { keyword }: { keyword: string }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const stickerIds = DatabaseService.getInstance().getKeywordStickers(keyword);
            return { success: true, stickerIds };
        } catch (error: any) {
            return { success: false, error: error.message, stickerIds: null };
        }
    });

    ipcMain.handle('db:getStickersByIds', async (_event, { stickerIds }: { stickerIds: number[] }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const stickers = DatabaseService.getInstance().getStickersByIds(stickerIds);
            return { success: true, stickers };
        } catch (error: any) {
            return { success: false, error: error.message, stickers: [] };
        }
    });

    ipcMain.handle('db:getAllCachedPackSummaries', async () => {
        try {
            if (isEmployeeMode()) return { success: true };
            const packs = DatabaseService.getInstance().getAllCachedPackSummaries();
            return { success: true, packs };
        } catch (error: any) {
            return { success: false, error: error.message, packs: [] };
        }
    });

    // ─── Friend Request Cache ─────────────────────────────────────────────
    ipcMain.handle('db:getFriendRequests', async (_event, { zaloId, direction }: { zaloId: string; direction: 'received' | 'sent' }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const requests = DatabaseService.getInstance().getFriendRequests(zaloId, direction);
            const lastFetched = DatabaseService.getInstance().getFriendRequestsLastFetched(zaloId, direction);
            return { success: true, requests, lastFetched };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveFriendRequests', async (_event, { zaloId, requests, direction }: { zaloId: string; requests: any[]; direction: 'received' | 'sent' }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:saveFriendRequests', { zaloId, requests, direction });
            DatabaseService.getInstance().saveFriendRequests(zaloId, requests, direction);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:upsertFriendRequest', async (_event, { zaloId, request, direction }: { zaloId: string; request: any; direction: 'received' | 'sent' }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:upsertFriendRequest', { zaloId, request, direction });
            DatabaseService.getInstance().upsertFriendRequest(zaloId, request, direction);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:removeFriendRequest', async (_event, { zaloId, userId, direction }: { zaloId: string; userId: string; direction: 'received' | 'sent' }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:removeFriendRequest', { zaloId, userId, direction });
            DatabaseService.getInstance().removeFriendRequest(zaloId, userId, direction);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:addFriend', async (_event, { zaloId, friend }: { zaloId: string; friend: any }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:addFriend', { zaloId, friend });
            DatabaseService.getInstance().addFriend(zaloId, friend);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:removeFriend', async (_event, { zaloId, userId }: { zaloId: string; userId: string }) => {
        try {
            if (isEmployeeMode()) proxyToBoss('db:removeFriend', { zaloId, userId });
            DatabaseService.getInstance().removeFriend(zaloId, userId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getMessagesByType', async (_event, { zaloId, threadId, msgType, limit = 100 }: { zaloId: string; threadId: string; msgType: string; limit?: number }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const messages = DatabaseService.getInstance().getMessagesByType(zaloId, threadId, msgType, limit);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Pinned Messages ──────────────────────────────────────────────────────

    // Nhân viên: ghim tin nhắn nằm trên DB Boss. Đọc qua proxy (trước đây trả rỗng → ghim xong ChatWindow tải lại thì
    // bảng ghim trống); ghi CHỜ Boss xác nhận rồi mới ghi bản sao cục bộ + phát event cho UI của chính mình — Boss lỗi /
    // từ chối thì trả lỗi để UI báo (trước đây fire-and-forget: UI báo "Đã ghim" dù Boss không ghi).
    ipcMain.handle('db:getPinnedMessages', async (_event, { zaloId, threadId }: { zaloId: string; threadId: string }) => {
        try {
            if (isEmployeeMode()) {
                const res = await proxyToBossWithResult('db:getPinnedMessages', { zaloId, threadId });
                return res?.success === false ? { ...res, pins: [] } : { success: true, pins: Array.isArray(res?.pins) ? res.pins : [] };
            }
            const pins = DatabaseService.getInstance().getPinnedMessages(zaloId, threadId);
            return { success: true, pins };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:pinMessage', async (_event, { zaloId, threadId, pin }: { zaloId: string; threadId: string; pin: any }) => {
        try {
            if (isEmployeeMode()) {
                const res = await proxyToBossWithResult('db:pinMessage', { zaloId, threadId, pin });
                if (res?.success === false) return res;
            }
            DatabaseService.getInstance().pinMessage(zaloId, threadId, pin);
            EventBroadcaster.emit('db:pinnedMessageChanged', { action: 'pin', ownerZaloId: zaloId, threadId, pin });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:unpinMessage', async (_event, { zaloId, threadId, msgId }: { zaloId: string; threadId: string; msgId: string }) => {
        try {
            if (isEmployeeMode()) {
                const res = await proxyToBossWithResult('db:unpinMessage', { zaloId, threadId, msgId });
                if (res?.success === false) return res;
            }
            DatabaseService.getInstance().unpinMessage(zaloId, threadId, msgId);
            EventBroadcaster.emit('db:pinnedMessageChanged', { action: 'unpin', ownerZaloId: zaloId, threadId, msgId });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:bringPinnedToTop', async (_event, { zaloId, threadId, msgId }: { zaloId: string; threadId: string; msgId: string }) => {
        try {
            if (isEmployeeMode()) {
                const res = await proxyToBossWithResult('db:bringPinnedToTop', { zaloId, threadId, msgId });
                if (res?.success === false) return res;
            }
            DatabaseService.getInstance().bringPinnedToTop(zaloId, threadId, msgId);
            EventBroadcaster.emit('db:pinnedMessageChanged', { action: 'bringToTop', ownerZaloId: zaloId, threadId, msgId });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Local Quick Messages ──────────────────────────────────────────────

    ipcMain.handle('db:getLocalQuickMessages', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const items = DatabaseService.getInstance().getLocalQuickMessages(zaloId);
            return { success: true, items };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:upsertLocalQuickMessage', async (_event, { zaloId, item }: { zaloId: string; item: { keyword: string; title: string; media?: any } }) => {
        try {
            const id = DatabaseService.getInstance().upsertLocalQuickMessage(zaloId, item);
            DatabaseService.getInstance()['save']?.();
            EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'upsert', ownerZaloId: zaloId, id, item });
            proxyToBoss('db:upsertLocalQuickMessage', { zaloId, item });
            return { success: true, id };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:deleteLocalQuickMessage', async (_event, { zaloId, id }: { zaloId: string; id: number }) => {
        try {
            DatabaseService.getInstance().deleteLocalQuickMessage(zaloId, id);
            DatabaseService.getInstance()['save']?.();
            EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'delete', ownerZaloId: zaloId, id });
            proxyToBoss('db:deleteLocalQuickMessage', { zaloId, id });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:bulkReplaceLocalQuickMessages', async (_event, { zaloId, items }: { zaloId: string; items: any[] }) => {
        try {
            DatabaseService.getInstance().bulkReplaceLocalQuickMessages(zaloId, items);
            EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'bulkReplace', ownerZaloId: zaloId });
            proxyToBoss('db:bulkReplaceLocalQuickMessages', { zaloId, items });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:cloneLocalQuickMessages', async (_event, { sourceZaloId, targetZaloId }: { sourceZaloId: string; targetZaloId: string }) => {
        try {
            const count = DatabaseService.getInstance().cloneLocalQuickMessages(sourceZaloId, targetZaloId);
            EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'clone', ownerZaloId: targetZaloId });
            proxyToBoss('db:cloneLocalQuickMessages', { sourceZaloId, targetZaloId });
            return { success: true, count };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getAllLocalQuickMessages', async () => {
        try {
            if (isEmployeeMode()) return { success: true };
            const items = DatabaseService.getInstance().getAllLocalQuickMessages();
            return { success: true, items };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:setLocalQMActive', async (_event, { id, isActive }: { id: number; isActive: number }) => {
        try {
            DatabaseService.getInstance().setLocalQMActive(id, isActive);
            EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'active', id, isActive });
            proxyToBoss('db:setLocalQMActive', { id, isActive });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:setLocalQMOrder', async (_event, { id, order }: { id: number; order: number }) => {
        try {
            DatabaseService.getInstance().setLocalQMOrder(id, order);
            EventBroadcaster.emit('db:localQuickMessageChanged', { action: 'reorder', id, order });
            proxyToBoss('db:setLocalQMOrder', { id, order });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Local Labels ──────────────────────────────────────────────────────

    ipcMain.handle('db:getLocalLabels', async (_event, { zaloId }) => {
        try {
            if (isEmployeeMode()) return { success: true, labels: [] };
            const labels = DatabaseService.getInstance().getLocalLabels(zaloId);
            return { success: true, labels };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:upsertLocalLabel', async (_event, { label }) => {
        try {
            const id = DatabaseService.getInstance().upsertLocalLabel(label);
            EventBroadcaster.emit('db:localLabelChanged', { action: 'upsert', label: { ...label, id } });
            proxyToBoss('db:upsertLocalLabel', { label: { ...label, id } });
            return { success: true, id };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:deleteLocalLabel', async (_event, { id }) => {
        try {
            DatabaseService.getInstance().deleteLocalLabel(id);
            EventBroadcaster.emit('db:localLabelChanged', { action: 'delete', labelId: id });
            proxyToBoss('db:deleteLocalLabel', { id });
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:setLocalLabelActive', async (_event, { id, isActive }: { id: number; isActive: number }) => {
        try {
            DatabaseService.getInstance().setLocalLabelActive(id, isActive);
            EventBroadcaster.emit('db:localLabelChanged', { action: 'active', labelId: id, isActive });
            proxyToBoss('db:setLocalLabelActive', { id, isActive });
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:setLocalLabelOrder', async (_event, { id, order }: { id: number; order: number }) => {
        try {
            DatabaseService.getInstance().setLocalLabelOrder(id, order);
            EventBroadcaster.emit('db:localLabelChanged', { action: 'reorder', labelId: id, order });
            proxyToBoss('db:setLocalLabelOrder', { id, order });
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:cloneLocalLabels', async (_event, { sourceZaloId, targetZaloId }) => {
        try {
            const count = DatabaseService.getInstance().cloneLocalLabels(sourceZaloId, targetZaloId);
            EventBroadcaster.emit('db:localLabelChanged', { action: 'clone' });
            proxyToBoss('db:cloneLocalLabels', { sourceZaloId, targetZaloId });
            return { success: true, count };
        } catch (err: any) { return { success: false, error: err.message }; }
    });

    ipcMain.handle('db:getLocalLabelThreads', async (_event, { zaloId }) => {
        try {
            if (isEmployeeMode()) return { success: true, threads: [] };
            const threads = DatabaseService.getInstance().getLocalLabelThreads(zaloId);
            return { success: true, threads };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:assignLocalLabelToThread', async (_event, { zaloId, labelId, threadId, threadType, labelText, labelColor, labelEmoji }: {
        zaloId: string; labelId: number; threadId: string;
        threadType?: number; labelText?: string; labelColor?: string; labelEmoji?: string;
    }) => {
        try {
            // Nhân viên: chỉ proxy MỘT lần ở cuối (db:assignLocalLabelToThread, đủ tham số cho trigger workflow trên Boss).
            // Bản cũ gửi thêm "assignLocalLabelToThread" (không tiền tố — Boss không có handler).
            DatabaseService.getInstance().assignLocalLabelToThread(zaloId, labelId, threadId);
            // Centralized workflow label event emission
            try {
                WorkflowEngineService.getInstance().triggerLabelEvent({
                    zaloId, threadId,
                    threadType: threadType ?? 0,
                    labelId,
                    labelText: labelText || '',
                    labelColor: labelColor || '',
                    labelEmoji: labelEmoji || '',
                    labelSource: 'local',
                    action: 'assigned',
                });
            } catch (err: any) {
                Logger.error(`[databaseIpc] assignLocalLabel workflow event error: ${err.message}`);
            }
            EventBroadcaster.emit('db:localLabelThreadChanged', { action: 'assign', ownerZaloId: zaloId, labelId, threadId });
            proxyToBoss('db:assignLocalLabelToThread', { zaloId, labelId, threadId, threadType, labelText, labelColor, labelEmoji });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ── Bulk assign labels — single transaction, no per-item IPC overhead ──
    ipcMain.handle('db:bulkAssignLocalLabelToThread', async (_event, { zaloId, labelIds, threadIds }: {
        zaloId: string; labelIds: number[]; threadIds: string[];
    }) => {
        try {
            const count = DatabaseService.getInstance().bulkAssignLocalLabelToThread(zaloId, labelIds, threadIds);
            // Emit single event after bulk operation
            EventBroadcaster.emit('db:localLabelThreadChanged', { action: 'bulkAssign', ownerZaloId: zaloId, labelIds, threadIds });
            proxyToBoss('db:bulkAssignLocalLabelToThread', { zaloId, labelIds, threadIds });
            return { success: true, count };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:removeLocalLabelFromThread', async (_event, { zaloId, labelId, threadId, threadType, labelText, labelColor, labelEmoji }: {
        zaloId: string; labelId: number; threadId: string;
        threadType?: number; labelText?: string; labelColor?: string; labelEmoji?: string;
    }) => {
        try {
            DatabaseService.getInstance().removeLocalLabelFromThread(zaloId, labelId, threadId);
            // Centralized workflow label event emission
            try {
                WorkflowEngineService.getInstance().triggerLabelEvent({
                    zaloId, threadId,
                    threadType: threadType ?? 0,
                    labelId,
                    labelText: labelText || '',
                    labelColor: labelColor || '',
                    labelEmoji: labelEmoji || '',
                    labelSource: 'local',
                    action: 'removed',
                });
            } catch (err: any) {
                Logger.error(`[databaseIpc] removeLocalLabel workflow event error: ${err.message}`);
            }
            EventBroadcaster.emit('db:localLabelThreadChanged', { action: 'remove', ownerZaloId: zaloId, labelId, threadId });
            proxyToBoss('db:removeLocalLabelFromThread', { zaloId, labelId, threadId, threadType, labelText, labelColor, labelEmoji });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getThreadLocalLabels', async (_event, { zaloId, threadId }: { zaloId: string; threadId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const labels = DatabaseService.getInstance().getThreadLocalLabels(zaloId, threadId);
            return { success: true, labels };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Contact Flags (mute / others) ───────────────────────────────────
    ipcMain.handle('db:setContactFlags', async (_event, { zaloId, contactId, flags }: { zaloId: string; contactId: string; flags: { is_muted?: number; mute_until?: number; is_in_others?: number } }) => {
        try {
            DatabaseService.getInstance().setContactFlags(zaloId, contactId, flags);
            EventBroadcaster.emit('db:contactFlagsChanged', { ownerZaloId: zaloId, contactId, flags });
            proxyToBoss('db:setContactFlags', { zaloId, contactId, flags });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getContactsWithFlags', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const rows = DatabaseService.getInstance().getContactsWithFlags(zaloId);
            return { success: true, rows };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:setContactAlias', async (_event, { zaloId, contactId, alias }: { zaloId: string; contactId: string; alias: string }) => {
        try {
            const db = DatabaseService.getInstance();
            // Mỗi lần kết nối lại Zalo lưu lại bí danh của cả danh bạ → chỉ phát event khi bí danh thật sự đổi
            const before = db.getContactById(zaloId, String(contactId || ''));
            db.setContactAlias(zaloId, contactId, alias);
            if (contactAliasChanged(before as any, alias)) {
                EventBroadcaster.emit('db:contactAliasChanged', { ownerZaloId: zaloId, contactId, alias });
            }
            proxyToBoss('db:setContactAlias', { zaloId, contactId, alias });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Message Drafts ───────────────────────────────────────────────────
    ipcMain.handle('db:upsertDraft', async (_event, { zaloId, threadId, content }: { zaloId: string; threadId: string; content: string }) => {
        try {
            DatabaseService.getInstance().upsertDraft(zaloId, threadId, content);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:deleteDraft', async (_event, { zaloId, threadId }: { zaloId: string; threadId: string }) => {
        try {
            DatabaseService.getInstance().deleteDraft(zaloId, threadId);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    // Bản nháp là dữ liệu CỦA MÁY (như Zalo PC): nhân viên ghi vào DB cục bộ của workspace (upsertDraft/deleteDraft ở
    // trên không proxy) nên cũng đọc từ đó. Trước đây chế độ nhân viên trả stub rỗng → nháp không bao giờ khôi phục.
    ipcMain.handle('db:getDraft', async (_event, { zaloId, threadId }: { zaloId: string; threadId: string }) => {
        try {
            const draft = DatabaseService.getInstance().getDraft(zaloId, threadId);
            return { success: true, draft };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:getDrafts', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            const drafts = DatabaseService.getInstance().getDrafts(zaloId);
            return { success: true, drafts };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:deleteOldDrafts', async (_event, { days }: { days?: number }) => {
        try {
            DatabaseService.getInstance().deleteOldDrafts(days);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    // ─── Bank Cards ─────────────────────────────────────────────────────
    // Nhân viên: thẻ ngân hàng nằm trên DB Boss (id do Boss cấp) — đọc / ghi đều proxy chờ kết quả, không ghi bản sao
    // cục bộ (id cục bộ khác id Boss → sửa / xoá theo id sẽ trúng thẻ khác). Trước đây proxy "upsertBankCard" (không
    // tiền tố, Boss không có handler) và đọc trả rỗng → nhân viên không bao giờ thấy / lưu được thẻ.
    ipcMain.handle('db:getBankCards', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            if (isEmployeeMode()) {
                const res = await proxyToBossWithResult('db:getBankCards', { zaloId });
                return res?.success === false ? { ...res, cards: [] } : { success: true, cards: Array.isArray(res?.cards) ? res.cards : [] };
            }
            const cards = DatabaseService.getInstance().getBankCards(zaloId);
            return { success: true, cards };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:upsertBankCard', async (_event, { zaloId, card }: { zaloId: string; card: any }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('db:upsertBankCard', { zaloId, card });
            const id = DatabaseService.getInstance().upsertBankCard(zaloId, card);
            if (!(id > 0)) return { success: false, error: 'Không lưu được thẻ ngân hàng' };
            return { success: true, id };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:deleteBankCard', async (_event, { zaloId, id }: { zaloId: string; id: number }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('db:deleteBankCard', { zaloId, id });
            DatabaseService.getInstance().deleteBankCard(zaloId, id);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    // ─── Local Pinned Conversations ──────────────────────────────────────
    ipcMain.handle('db:getLocalPinnedConversations', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true };
            const threadIds = DatabaseService.getInstance().getLocalPinnedConversations(zaloId);
            return { success: true, threadIds };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:setLocalPinnedConversation', async (_event, { zaloId, threadId, isPinned }: { zaloId: string; threadId: string; isPinned: boolean }) => {
        try {
            DatabaseService.getInstance().setLocalPinnedConversation(zaloId, threadId, isPinned);
            EventBroadcaster.emit('db:pinnedConversationChanged', { ownerZaloId: zaloId, threadId, isPinned });
            proxyToBoss('db:setLocalPinnedConversation', { zaloId, threadId, isPinned });
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    // ─── Tự động đánh dấu đã đọc: hội thoại chưa đọc theo thời gian tin cuối ───
    ipcMain.handle('db:getUnreadConversations', async (_event, params: { zaloId: string; from?: number; to?: number; includeOthers?: boolean; channel?: string }) => {
        try {
            if (isEmployeeMode()) return { success: true, conversations: [] };
            const { zaloId, ...opts } = params || ({} as any);
            return { success: true, conversations: DatabaseService.getInstance().getUnreadConversations(zaloId, opts) };
        } catch (error: any) { return { success: false, error: error.message, conversations: [] }; }
    });

    // ─── Starred messages ("Tin đánh dấu") ───────────────────────────────
    // Employee mode reads / writes through Boss REST (DataAccessor), like local pins.
    ipcMain.handle('db:getStarredMessageKeys', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true, keys: [] };
            return { success: true, keys: DatabaseService.getInstance().getStarredMessageKeys(zaloId) };
        } catch (error: any) { return { success: false, error: error.message, keys: [] }; }
    });

    ipcMain.handle('db:getStarredMessages', async (_event, { zaloIds, limit, offset }: { zaloIds: string[]; limit?: number; offset?: number }) => {
        try {
            if (isEmployeeMode()) return { success: true, items: [], hasMore: false };
            const pageSize = Math.max(1, Math.min(200, Number(limit) || 50));
            const rows = DatabaseService.getInstance().getStarredMessages(Array.isArray(zaloIds) ? zaloIds : [], pageSize + 1, offset || 0);
            return { success: true, items: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
        } catch (error: any) { return { success: false, error: error.message, items: [], hasMore: false }; }
    });

    ipcMain.handle('db:setMessageStarred', async (_event, { zaloId, threadId, msgId, starred, snapshot }: { zaloId: string; threadId: string; msgId: string; starred: boolean; snapshot?: unknown }) => {
        try {
            DatabaseService.getInstance().setMessageStarred(zaloId, String(threadId || ''), String(msgId || ''), !!starred, snapshot);
            EventBroadcaster.emit('db:starredMessageChanged', { ownerZaloId: zaloId, threadId, msgId, starred: !!starred });
            proxyToBoss('db:setMessageStarred', { zaloId, threadId, msgId, starred, snapshot });
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });
}
