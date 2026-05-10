import { ipcMain, app, dialog } from 'electron';
import DatabaseService from '../../src/services/DatabaseService';
import FileStorageService from '../../src/services/FileStorageService';
import WorkflowEngineService from '../../src/services/WorkflowEngineService';
import Logger from '../../src/utils/Logger';
import * as path from 'path';
import * as fs from 'fs';

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

// Đếm tổng số file trong thư mục (recursive) — dùng để hiện tiến trình X / Y.
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
    ipcMain.handle('db:getMessages', async (_event, { zaloId, threadId, limit = 50, offset = 0, before = 0 }) => {
        try {
            Logger.log(`[databaseIpc] db:getMessages zaloId=${zaloId} threadId=${threadId} limit=${limit} offset=${offset} before=${before}`);
            const messages = DatabaseService.getInstance().getMessages(zaloId, threadId, limit, offset, before > 0 ? before : undefined);
            Logger.log(`[databaseIpc] db:getMessages → ${messages.length} msgs returned`);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getMessagesAround', async (_event, { zaloId, threadId, timestamp, limit = 50 }) => {
        try {
            const messages = DatabaseService.getInstance().getMessagesAround(zaloId, threadId, timestamp, limit);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getContacts', async (_event, { zaloId }) => {
        try {
            const contacts = DatabaseService.getInstance().getContacts(zaloId);
            return { success: true, contacts };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:searchMessages', async (_event, { zaloId, query }) => {
        try {
            const results = DatabaseService.getInstance().searchMessages(zaloId, query);
            return { success: true, results };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getMediaMessages', async (_event, { zaloId, threadId, limit, offset }) => {
        try {
            const messages = threadId
                ? DatabaseService.getInstance().getMediaMessages(zaloId, threadId, limit ?? 50, offset ?? 0)
                : DatabaseService.getInstance().getAllLocalMediaMessages(zaloId);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getFileMessages', async (_event, { zaloId, threadId, limit, offset }) => {
        try {
            const messages = DatabaseService.getInstance().getFileMessages(zaloId, threadId, limit ?? 50, offset ?? 0);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getUnreadCount', async (_event, { zaloId }) => {
        try {
            const total = DatabaseService.getInstance().getTotalUnread(zaloId);
            return { success: true, total };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:markAsRead', async (_event, { zaloId, contactId }) => {
        try {
            DatabaseService.getInstance().markAsRead(zaloId, contactId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:markMessageRecalled', async (_event, { zaloId, msgId }) => {
        try {
            DatabaseService.getInstance().markMessageRecalled(zaloId, msgId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:deleteMessages', async (_event, { zaloId, msgIds }: { zaloId: string; msgIds: string[] }) => {
        try {
            DatabaseService.getInstance().deleteMessages(zaloId, msgIds);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:updateContactProfile', async (_event, { zaloId, contactId, displayName, avatarUrl, phone, contactType, gender, birthday }) => {
        try {
            DatabaseService.getInstance().updateContactProfile(zaloId, contactId, displayName || '', avatarUrl || '', phone || '', contactType || '', gender ?? null, birthday ?? null);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:updateAccountPhone', async (_event, { zaloId, phone }: { zaloId: string; phone: string }) => {
        try {
            DatabaseService.getInstance().updateAccountPhone(zaloId, phone);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:updateReaction', async (_event, { zaloId, msgId, userId, icon }) => {
        try {
            DatabaseService.getInstance().updateMessageReaction(zaloId, String(msgId), userId, icon || '');
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

    ipcMain.handle('db:getMessageById', async (_event, { zaloId, msgId }) => {
        try {
            const message = DatabaseService.getInstance().getMessageById(zaloId, String(msgId));
            return { success: true, message: message || null };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Storage path management ──────────────────────────────────────────
    ipcMain.handle('db:getStoragePath', async () => {
        try {
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
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:setStoragePath', async (event, { newFolder, useExisting }: { newFolder: string; useExisting?: boolean }) => {
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
                // Works for any old base dir — no need to rewriteLocalPaths first.
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
            // Chạy ngay cả khi media copy có lỗi một phần (mediaError set) — DB đã được
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
    });

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
            const isFriend = DatabaseService.getInstance().checkIsFriend(zaloId, userId);
            return { success: true, isFriend };
        } catch (error: any) {
            return { success: false, isFriend: false, error: error.message };
        }
    });

    ipcMain.handle('db:getFriends', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            const friends = DatabaseService.getInstance().getFriends(zaloId);
            const lastFetched = DatabaseService.getInstance().getFriendsLastFetched(zaloId);
            return { success: true, friends, lastFetched };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveFriends', async (_event, { zaloId, friends }: { zaloId: string; friends: any[] }) => {
        try {
            DatabaseService.getInstance().saveFriends(zaloId, friends);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:deleteConversation', async (_event, { zaloId, contactId }: { zaloId: string; contactId: string }) => {
        try {
            DatabaseService.getInstance().deleteConversation(zaloId, contactId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getLinks', async (_event, { zaloId, threadId, limit, offset }: { zaloId: string; threadId: string; limit?: number; offset?: number }) => {
        try {
            const links = DatabaseService.getInstance().getLinks(zaloId, threadId, limit ?? 50, offset ?? 0);
            return { success: true, links };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveLink', async (_event, { zaloId, threadId, msgId, url, title, domain, thumbUrl, timestamp }: any) => {
        try {
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
            DatabaseService.getInstance().saveGroupMembers(zaloId, groupId, members);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:upsertGroupMember', async (_event, { zaloId, groupId, member }: { zaloId: string; groupId: string; member: any }) => {
        try {
            DatabaseService.getInstance().upsertGroupMember(zaloId, groupId, member);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:removeGroupMember', async (_event, { zaloId, groupId, memberId }: { zaloId: string; groupId: string; memberId: string }) => {
        try {
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
            DatabaseService.getInstance().saveStickers(stickers || []);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getStickerById', async (_event, { stickerId }: { stickerId: number }) => {
        try {
            const sticker = DatabaseService.getInstance().getStickerById(stickerId);
            return { success: true, sticker: sticker || null };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getRecentStickers', async (_event, params: any) => {
        try {
            const limit = params?.limit ?? 30;
            const stickers = DatabaseService.getInstance().getRecentStickers(limit);
            return { success: true, stickers };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:addRecentSticker', async (_event, { stickerId }: { stickerId: number }) => {
        try {
            DatabaseService.getInstance().addRecentSticker(stickerId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:markStickerUnsupported', async (_event, { stickerId }: { stickerId: number }) => {
        try {
            DatabaseService.getInstance().markStickerUnsupported(stickerId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveStickerPacks', async (_event, { packs }: { packs: any[] }) => {
        try {
            DatabaseService.getInstance().saveStickerPacks(packs || []);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getStickerPacks', async () => {
        try {
            const packs = DatabaseService.getInstance().getStickerPacks();
            return { success: true, packs };
        } catch (error: any) {
            return { success: false, error: error.message, packs: [] };
        }
    });

    ipcMain.handle('db:getStickersByPackId', async (_event, { catId }: { catId: number }) => {
        try {
            const stickers = DatabaseService.getInstance().getStickersByPackId(catId);
            return { success: true, stickers };
        } catch (error: any) {
            return { success: false, error: error.message, stickers: [] };
        }
    });

    // ─── Keyword Stickers Cache ─────────────────────────────────────────

    ipcMain.handle('db:saveKeywordStickers', async (_event, { keyword, stickerIds }: { keyword: string; stickerIds: number[] }) => {
        try {
            DatabaseService.getInstance().saveKeywordStickers(keyword, stickerIds);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getKeywordStickers', async (_event, { keyword }: { keyword: string }) => {
        try {
            const stickerIds = DatabaseService.getInstance().getKeywordStickers(keyword);
            return { success: true, stickerIds };
        } catch (error: any) {
            return { success: false, error: error.message, stickerIds: null };
        }
    });

    ipcMain.handle('db:getStickersByIds', async (_event, { stickerIds }: { stickerIds: number[] }) => {
        try {
            const stickers = DatabaseService.getInstance().getStickersByIds(stickerIds);
            return { success: true, stickers };
        } catch (error: any) {
            return { success: false, error: error.message, stickers: [] };
        }
    });

    ipcMain.handle('db:getAllCachedPackSummaries', async () => {
        try {
            const packs = DatabaseService.getInstance().getAllCachedPackSummaries();
            return { success: true, packs };
        } catch (error: any) {
            return { success: false, error: error.message, packs: [] };
        }
    });

    // ─── Friend Request Cache ─────────────────────────────────────────────
    ipcMain.handle('db:getFriendRequests', async (_event, { zaloId, direction }: { zaloId: string; direction: 'received' | 'sent' }) => {
        try {
            const requests = DatabaseService.getInstance().getFriendRequests(zaloId, direction);
            const lastFetched = DatabaseService.getInstance().getFriendRequestsLastFetched(zaloId, direction);
            return { success: true, requests, lastFetched };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:saveFriendRequests', async (_event, { zaloId, requests, direction }: { zaloId: string; requests: any[]; direction: 'received' | 'sent' }) => {
        try {
            DatabaseService.getInstance().saveFriendRequests(zaloId, requests, direction);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:upsertFriendRequest', async (_event, { zaloId, request, direction }: { zaloId: string; request: any; direction: 'received' | 'sent' }) => {
        try {
            DatabaseService.getInstance().upsertFriendRequest(zaloId, request, direction);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:removeFriendRequest', async (_event, { zaloId, userId, direction }: { zaloId: string; userId: string; direction: 'received' | 'sent' }) => {
        try {
            DatabaseService.getInstance().removeFriendRequest(zaloId, userId, direction);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:addFriend', async (_event, { zaloId, friend }: { zaloId: string; friend: any }) => {
        try {
            DatabaseService.getInstance().addFriend(zaloId, friend);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:removeFriend', async (_event, { zaloId, userId }: { zaloId: string; userId: string }) => {
        try {
            DatabaseService.getInstance().removeFriend(zaloId, userId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getMessagesByType', async (_event, { zaloId, threadId, msgType, limit = 100 }: { zaloId: string; threadId: string; msgType: string; limit?: number }) => {
        try {
            const messages = DatabaseService.getInstance().getMessagesByType(zaloId, threadId, msgType, limit);
            return { success: true, messages };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Pinned Messages ──────────────────────────────────────────────────────

    ipcMain.handle('db:getPinnedMessages', async (_event, { zaloId, threadId }: { zaloId: string; threadId: string }) => {
        try {
            const pins = DatabaseService.getInstance().getPinnedMessages(zaloId, threadId);
            return { success: true, pins };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:pinMessage', async (_event, { zaloId, threadId, pin }: { zaloId: string; threadId: string; pin: any }) => {
        try {
            DatabaseService.getInstance().pinMessage(zaloId, threadId, pin);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:unpinMessage', async (_event, { zaloId, threadId, msgId }: { zaloId: string; threadId: string; msgId: string }) => {
        try {
            DatabaseService.getInstance().unpinMessage(zaloId, threadId, msgId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:bringPinnedToTop', async (_event, { zaloId, threadId, msgId }: { zaloId: string; threadId: string; msgId: string }) => {
        try {
            DatabaseService.getInstance().bringPinnedToTop(zaloId, threadId, msgId);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Local Quick Messages ──────────────────────────────────────────────

    ipcMain.handle('db:getLocalQuickMessages', async (_event, { zaloId }: { zaloId: string }) => {
        try {
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
            return { success: true, id };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:deleteLocalQuickMessage', async (_event, { zaloId, id }: { zaloId: string; id: number }) => {
        try {
            DatabaseService.getInstance().deleteLocalQuickMessage(zaloId, id);
            DatabaseService.getInstance()['save']?.();
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:bulkReplaceLocalQuickMessages', async (_event, { zaloId, items }: { zaloId: string; items: any[] }) => {
        try {
            DatabaseService.getInstance().bulkReplaceLocalQuickMessages(zaloId, items);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:cloneLocalQuickMessages', async (_event, { sourceZaloId, targetZaloId }: { sourceZaloId: string; targetZaloId: string }) => {
        try {
            const count = DatabaseService.getInstance().cloneLocalQuickMessages(sourceZaloId, targetZaloId);
            return { success: true, count };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getAllLocalQuickMessages', async () => {
        try {
            const items = DatabaseService.getInstance().getAllLocalQuickMessages();
            return { success: true, items };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:setLocalQMActive', async (_event, { id, isActive }: { id: number; isActive: number }) => {
        try {
            DatabaseService.getInstance().setLocalQMActive(id, isActive);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:setLocalQMOrder', async (_event, { id, order }: { id: number; order: number }) => {
        try {
            DatabaseService.getInstance().setLocalQMOrder(id, order);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ─── Local Labels ──────────────────────────────────────────────────────

    ipcMain.handle('db:getLocalLabels', async (_event, { zaloId }) => {
        try {
            const labels = DatabaseService.getInstance().getLocalLabels(zaloId);
            return { success: true, labels };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:upsertLocalLabel', async (_event, { label }) => {
        try {
            const id = DatabaseService.getInstance().upsertLocalLabel(label);
            return { success: true, id };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:deleteLocalLabel', async (_event, { id }) => {
        try {
            DatabaseService.getInstance().deleteLocalLabel(id);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:setLocalLabelActive', async (_event, { id, isActive }: { id: number; isActive: number }) => {
        try {
            DatabaseService.getInstance().setLocalLabelActive(id, isActive);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:setLocalLabelOrder', async (_event, { id, order }: { id: number; order: number }) => {
        try {
            DatabaseService.getInstance().setLocalLabelOrder(id, order);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:cloneLocalLabels', async (_event, { sourceZaloId, targetZaloId }) => {
        try {
            const count = DatabaseService.getInstance().cloneLocalLabels(sourceZaloId, targetZaloId);
            return { success: true, count };
        } catch (err: any) { return { success: false, error: err.message }; }
    });

    ipcMain.handle('db:getLocalLabelThreads', async (_event, { zaloId }) => {
        try {
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
            return { success: true };
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
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getThreadLocalLabels', async (_event, { zaloId, threadId }: { zaloId: string; threadId: string }) => {
        try {
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
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:getContactsWithFlags', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            const rows = DatabaseService.getInstance().getContactsWithFlags(zaloId);
            return { success: true, rows };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('db:setContactAlias', async (_event, { zaloId, contactId, alias }: { zaloId: string; contactId: string; alias: string }) => {
        try {
            DatabaseService.getInstance().setContactAlias(zaloId, contactId, alias);
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
    ipcMain.handle('db:getBankCards', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            const cards = DatabaseService.getInstance().getBankCards(zaloId);
            return { success: true, cards };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:upsertBankCard', async (_event, { zaloId, card }: { zaloId: string; card: any }) => {
        try {
            const id = DatabaseService.getInstance().upsertBankCard(zaloId, card);
            return { success: true, id };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:deleteBankCard', async (_event, { zaloId, id }: { zaloId: string; id: number }) => {
        try {
            DatabaseService.getInstance().deleteBankCard(zaloId, id);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    // ─── Local Pinned Conversations ──────────────────────────────────────
    ipcMain.handle('db:getLocalPinnedConversations', async (_event, { zaloId }: { zaloId: string }) => {
        try {
            const threadIds = DatabaseService.getInstance().getLocalPinnedConversations(zaloId);
            return { success: true, threadIds };
        } catch (error: any) { return { success: false, error: error.message }; }
    });

    ipcMain.handle('db:setLocalPinnedConversation', async (_event, { zaloId, threadId, isPinned }: { zaloId: string; threadId: string; isPinned: boolean }) => {
        try {
            DatabaseService.getInstance().setLocalPinnedConversation(zaloId, threadId, isPinned);
            return { success: true };
        } catch (error: any) { return { success: false, error: error.message }; }
    });
}
