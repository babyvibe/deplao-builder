"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDatabaseIpc = registerDatabaseIpc;
const electron_1 = require("electron");
const DatabaseService_1 = __importDefault(require("../../src/services/DatabaseService"));
const FileStorageService_1 = __importDefault(require("../../src/services/FileStorageService"));
const WorkflowEngineService_1 = __importDefault(require("../../src/services/WorkflowEngineService"));
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
// Copy toàn bộ thư mục src → dest (async, recursive).
// opts.overwrite=true → ghi đè file đã tồn tại; opts.onFile → progress callback.
// Yield to event-loop every 20 files so IPC progress events can be delivered.
async function copyDirRecursive(src, dest, opts, _counter = { n: 0 }) {
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDirRecursive(srcPath, destPath, opts, _counter);
        }
        else {
            const exists = !opts?.overwrite && await fs.promises.access(destPath).then(() => true).catch(() => false);
            if (!exists) {
                await fs.promises.copyFile(srcPath, destPath);
                _counter.n++;
                opts?.onFile?.(_counter.n);
                // Yield every 20 files → cho phép IPC events được gửi đi
                if (_counter.n % 20 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
        }
    }
    return _counter.n;
}
// Đếm tổng số file trong thư mục (recursive) — dùng để hiện tiến trình X / Y.
async function countFiles(dir) {
    let count = 0;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            count += await countFiles(path.join(dir, entry.name));
        }
        else {
            count++;
        }
    }
    return count;
}
function registerDatabaseIpc() {
    electron_1.ipcMain.handle('db:getMessages', async (_event, { zaloId, threadId, limit = 50, offset = 0, before = 0 }) => {
        try {
            Logger_1.default.log(`[databaseIpc] db:getMessages zaloId=${zaloId} threadId=${threadId} limit=${limit} offset=${offset} before=${before}`);
            const messages = DatabaseService_1.default.getInstance().getMessages(zaloId, threadId, limit, offset, before > 0 ? before : undefined);
            Logger_1.default.log(`[databaseIpc] db:getMessages → ${messages.length} msgs returned`);
            return { success: true, messages };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getMessagesAround', async (_event, { zaloId, threadId, timestamp, limit = 50 }) => {
        try {
            const messages = DatabaseService_1.default.getInstance().getMessagesAround(zaloId, threadId, timestamp, limit);
            return { success: true, messages };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getContacts', async (_event, { zaloId }) => {
        try {
            const contacts = DatabaseService_1.default.getInstance().getContacts(zaloId);
            return { success: true, contacts };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:searchMessages', async (_event, { zaloId, query }) => {
        try {
            const results = DatabaseService_1.default.getInstance().searchMessages(zaloId, query);
            return { success: true, results };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getMediaMessages', async (_event, { zaloId, threadId, limit, offset }) => {
        try {
            const messages = threadId
                ? DatabaseService_1.default.getInstance().getMediaMessages(zaloId, threadId, limit ?? 50, offset ?? 0)
                : DatabaseService_1.default.getInstance().getAllLocalMediaMessages(zaloId);
            return { success: true, messages };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getFileMessages', async (_event, { zaloId, threadId, limit, offset }) => {
        try {
            const messages = DatabaseService_1.default.getInstance().getFileMessages(zaloId, threadId, limit ?? 50, offset ?? 0);
            return { success: true, messages };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getUnreadCount', async (_event, { zaloId }) => {
        try {
            const total = DatabaseService_1.default.getInstance().getTotalUnread(zaloId);
            return { success: true, total };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:markAsRead', async (_event, { zaloId, contactId }) => {
        try {
            DatabaseService_1.default.getInstance().markAsRead(zaloId, contactId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:markMessageRecalled', async (_event, { zaloId, msgId }) => {
        try {
            DatabaseService_1.default.getInstance().markMessageRecalled(zaloId, msgId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:deleteMessages', async (_event, { zaloId, msgIds }) => {
        try {
            DatabaseService_1.default.getInstance().deleteMessages(zaloId, msgIds);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:updateContactProfile', async (_event, { zaloId, contactId, displayName, avatarUrl, phone, contactType, gender, birthday }) => {
        try {
            DatabaseService_1.default.getInstance().updateContactProfile(zaloId, contactId, displayName || '', avatarUrl || '', phone || '', contactType || '', gender ?? null, birthday ?? null);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:updateAccountPhone', async (_event, { zaloId, phone }) => {
        try {
            DatabaseService_1.default.getInstance().updateAccountPhone(zaloId, phone);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:updateReaction', async (_event, { zaloId, msgId, userId, icon }) => {
        try {
            DatabaseService_1.default.getInstance().updateMessageReaction(zaloId, String(msgId), userId, icon || '');
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:updateLocalPaths', async (_event, { zaloId, msgId, localPaths }) => {
        try {
            DatabaseService_1.default.getInstance().updateLocalPaths(zaloId, String(msgId), localPaths || {});
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getMessageById', async (_event, { zaloId, msgId }) => {
        try {
            const message = DatabaseService_1.default.getInstance().getMessageById(zaloId, String(msgId));
            return { success: true, message: message || null };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Storage path management ──────────────────────────────────────────
    electron_1.ipcMain.handle('db:getStoragePath', async () => {
        try {
            const userDataPath = electron_1.app.getPath('userData');
            const configPath = path.join(userDataPath, 'deplao-config.json');
            let customPath = null;
            if (fs.existsSync(configPath)) {
                try {
                    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    customPath = cfg.dbFolder || null;
                }
                catch { }
            }
            const currentPath = customPath || userDataPath;
            const actualDbPath = DatabaseService_1.default.getInstance().getDbPath();
            return {
                success: true,
                path: currentPath,
                defaultPath: userDataPath,
                configPath,
                actualDbPath,
                configExists: fs.existsSync(configPath),
            };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:setStoragePath', async (event, { newFolder, useExisting }) => {
        try {
            if (!fs.existsSync(newFolder)) {
                fs.mkdirSync(newFolder, { recursive: true });
            }
            const configPath = path.join(electron_1.app.getPath('userData'), 'deplao-config.json');
            const oldDbPath = DatabaseService_1.default.getInstance().getDbPath();
            const newDbPath = path.join(newFolder, 'deplao-tool.db');
            if (oldDbPath === newDbPath) {
                return { success: true, newPath: newDbPath, message: 'Thư mục không thay đổi.' };
            }
            if (useExisting) {
                // ── Chế độ "dùng dữ liệu cũ": chỉ cập nhật config, không copy ──────────
                let cfg = {};
                if (fs.existsSync(configPath)) {
                    try {
                        cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                    }
                    catch { }
                }
                cfg.dbFolder = newFolder;
                fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
                await DatabaseService_1.default.getInstance().reinitialize();
                FileStorageService_1.default.resetBaseDir();
                // Convert ALL absolute local_paths → relative (folder-agnostic).
                // Works for any old base dir — no need to rewriteLocalPaths first.
                try {
                    const migrated = DatabaseService_1.default.getInstance().migrateAllAbsolutePathsToRelative();
                    if (migrated > 0) {
                        DatabaseService_1.default.getInstance().forceFlush();
                        console.log(`[databaseIpc] useExisting: migrated ${migrated} messages to relative paths`);
                    }
                }
                catch { }
                return { success: true, newPath: newDbPath, message: 'Đã chuyển sang dữ liệu cũ thành công.' };
            }
            // ── Bước 1: Force flush in-memory DB → disk ───────────────────────────────
            DatabaseService_1.default.getInstance().forceFlush();
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
            let mediaError;
            if (oldMediaDir !== newMediaDir && fs.existsSync(oldMediaDir)) {
                // Đếm trước tổng số file để UI hiển thị tiến trình X/Y
                try {
                    mediaTotal = await countFiles(oldMediaDir);
                    try {
                        event.sender.send('db:copyProgress', { copied: 0, total: mediaTotal });
                    }
                    catch { }
                }
                catch { }
                try {
                    mediaCopied = await copyDirRecursive(oldMediaDir, newMediaDir, {
                        overwrite: true,
                        onFile: (count) => {
                            try {
                                event.sender.send('db:copyProgress', { copied: count, total: mediaTotal });
                            }
                            catch { }
                        },
                    });
                    // Emit hoàn tất
                    try {
                        event.sender.send('db:copyProgress', { copied: mediaCopied, total: mediaTotal, done: true });
                    }
                    catch { }
                }
                catch (copyErr) {
                    mediaError = copyErr.message;
                    console.error(`[databaseIpc] Media copy error: ${copyErr.message}`);
                }
            }
            // ── Bước 4: Lưu config ────────────────────────────────────────────────────
            let cfg = {};
            if (fs.existsSync(configPath)) {
                try {
                    cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                }
                catch { }
            }
            cfg.dbFolder = newFolder;
            fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
            // ── Bước 5: Reinitialize DatabaseService từ path mới ─────────────────────
            await DatabaseService_1.default.getInstance().reinitialize();
            // ── Bước 6: Reset FileStorageService cache ────────────────────────────────
            FileStorageService_1.default.resetBaseDir();
            // ── Bước 7: Cập nhật local_paths trong DB sang đường dẫn mới ─────────────
            // Chạy ngay cả khi media copy có lỗi một phần (mediaError set) — DB đã được
            // copy xong nên paths cần được rewrite để trỏ đúng vào vị trí mới.
            let pathsRewritten = 0;
            if (oldMediaDir !== newMediaDir) {
                try {
                    pathsRewritten = DatabaseService_1.default.getInstance().rewriteLocalPaths(oldMediaDir, newMediaDir);
                }
                catch (rewriteErr) {
                    console.error(`[databaseIpc] rewriteLocalPaths error: ${rewriteErr.message}`);
                }
            }
            // ── Bước 8: Chuyển tất cả absolute paths còn lại sang relative ────────────
            // Sau bước 7, mọi path từ oldMediaDir đã được rewrite sang newMediaDir.
            // Bước này parse JSON đúng cách và convert BẤT KỲ absolute path nào còn lại
            // (kể cả path từ các lần đổi folder cũ hơn) → relative, folder-agnostic.
            let pathsMigrated = 0;
            try {
                pathsMigrated = DatabaseService_1.default.getInstance().migrateAllAbsolutePathsToRelative();
            }
            catch (migrateErr) {
                console.error(`[databaseIpc] migrateAllAbsolutePathsToRelative error: ${migrateErr.message}`);
            }
            if (pathsRewritten > 0 || pathsMigrated > 0) {
                DatabaseService_1.default.getInstance().forceFlush();
            }
            const message = mediaCopied > 0
                ? `Đã sao chép DB + ${mediaCopied.toLocaleString()} file media thành công.`
                : 'Đã thay đổi thư mục lưu trữ thành công.';
            return { success: true, newPath: newDbPath, message, mediaCopied, mediaError, pathsRewritten, pathsMigrated };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:selectStorageFolder', async () => {
        try {
            const result = await electron_1.dialog.showOpenDialog({
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
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Friend Cache ─────────────────────────────────────────────────────
    electron_1.ipcMain.handle('db:isFriend', async (_event, { zaloId, userId }) => {
        try {
            const isFriend = DatabaseService_1.default.getInstance().checkIsFriend(zaloId, userId);
            return { success: true, isFriend };
        }
        catch (error) {
            return { success: false, isFriend: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getFriends', async (_event, { zaloId }) => {
        try {
            const friends = DatabaseService_1.default.getInstance().getFriends(zaloId);
            const lastFetched = DatabaseService_1.default.getInstance().getFriendsLastFetched(zaloId);
            return { success: true, friends, lastFetched };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:saveFriends', async (_event, { zaloId, friends }) => {
        try {
            DatabaseService_1.default.getInstance().saveFriends(zaloId, friends);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:deleteConversation', async (_event, { zaloId, contactId }) => {
        try {
            DatabaseService_1.default.getInstance().deleteConversation(zaloId, contactId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getLinks', async (_event, { zaloId, threadId, limit, offset }) => {
        try {
            const links = DatabaseService_1.default.getInstance().getLinks(zaloId, threadId, limit ?? 50, offset ?? 0);
            return { success: true, links };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:saveLink', async (_event, { zaloId, threadId, msgId, url, title, domain, thumbUrl, timestamp }) => {
        try {
            DatabaseService_1.default.getInstance().saveLink(zaloId, threadId, msgId, url || '', title || '', domain || '', thumbUrl || '', timestamp || Date.now());
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Group Member Cache ───────────────────────────────────────────────
    electron_1.ipcMain.handle('db:getGroupMembers', async (_event, { zaloId, groupId }) => {
        try {
            const members = DatabaseService_1.default.getInstance().getGroupMembers(zaloId, groupId);
            return { success: true, members };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getAllGroupMembers', async (_event, { zaloId }) => {
        try {
            const rows = DatabaseService_1.default.getInstance().getAllGroupMembers(zaloId);
            return { success: true, rows };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:saveGroupMembers', async (_event, { zaloId, groupId, members }) => {
        try {
            DatabaseService_1.default.getInstance().saveGroupMembers(zaloId, groupId, members);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:upsertGroupMember', async (_event, { zaloId, groupId, member }) => {
        try {
            DatabaseService_1.default.getInstance().upsertGroupMember(zaloId, groupId, member);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:removeGroupMember', async (_event, { zaloId, groupId, memberId }) => {
        try {
            DatabaseService_1.default.getInstance().removeGroupMember(zaloId, groupId, memberId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Sticker Cache ────────────────────────────────────────────────
    // ─── Sticker Cache ────────────────────────────────────────────────────
    electron_1.ipcMain.handle('db:saveStickers', async (_event, { stickers }) => {
        try {
            DatabaseService_1.default.getInstance().saveStickers(stickers || []);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getStickerById', async (_event, { stickerId }) => {
        try {
            const sticker = DatabaseService_1.default.getInstance().getStickerById(stickerId);
            return { success: true, sticker: sticker || null };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getRecentStickers', async (_event, params) => {
        try {
            const limit = params?.limit ?? 30;
            const stickers = DatabaseService_1.default.getInstance().getRecentStickers(limit);
            return { success: true, stickers };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:addRecentSticker', async (_event, { stickerId }) => {
        try {
            DatabaseService_1.default.getInstance().addRecentSticker(stickerId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:markStickerUnsupported', async (_event, { stickerId }) => {
        try {
            DatabaseService_1.default.getInstance().markStickerUnsupported(stickerId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:saveStickerPacks', async (_event, { packs }) => {
        try {
            DatabaseService_1.default.getInstance().saveStickerPacks(packs || []);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getStickerPacks', async () => {
        try {
            const packs = DatabaseService_1.default.getInstance().getStickerPacks();
            return { success: true, packs };
        }
        catch (error) {
            return { success: false, error: error.message, packs: [] };
        }
    });
    electron_1.ipcMain.handle('db:getStickersByPackId', async (_event, { catId }) => {
        try {
            const stickers = DatabaseService_1.default.getInstance().getStickersByPackId(catId);
            return { success: true, stickers };
        }
        catch (error) {
            return { success: false, error: error.message, stickers: [] };
        }
    });
    // ─── Keyword Stickers Cache ─────────────────────────────────────────
    electron_1.ipcMain.handle('db:saveKeywordStickers', async (_event, { keyword, stickerIds }) => {
        try {
            DatabaseService_1.default.getInstance().saveKeywordStickers(keyword, stickerIds);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getKeywordStickers', async (_event, { keyword }) => {
        try {
            const stickerIds = DatabaseService_1.default.getInstance().getKeywordStickers(keyword);
            return { success: true, stickerIds };
        }
        catch (error) {
            return { success: false, error: error.message, stickerIds: null };
        }
    });
    electron_1.ipcMain.handle('db:getStickersByIds', async (_event, { stickerIds }) => {
        try {
            const stickers = DatabaseService_1.default.getInstance().getStickersByIds(stickerIds);
            return { success: true, stickers };
        }
        catch (error) {
            return { success: false, error: error.message, stickers: [] };
        }
    });
    electron_1.ipcMain.handle('db:getAllCachedPackSummaries', async () => {
        try {
            const packs = DatabaseService_1.default.getInstance().getAllCachedPackSummaries();
            return { success: true, packs };
        }
        catch (error) {
            return { success: false, error: error.message, packs: [] };
        }
    });
    // ─── Friend Request Cache ─────────────────────────────────────────────
    electron_1.ipcMain.handle('db:getFriendRequests', async (_event, { zaloId, direction }) => {
        try {
            const requests = DatabaseService_1.default.getInstance().getFriendRequests(zaloId, direction);
            const lastFetched = DatabaseService_1.default.getInstance().getFriendRequestsLastFetched(zaloId, direction);
            return { success: true, requests, lastFetched };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:saveFriendRequests', async (_event, { zaloId, requests, direction }) => {
        try {
            DatabaseService_1.default.getInstance().saveFriendRequests(zaloId, requests, direction);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:upsertFriendRequest', async (_event, { zaloId, request, direction }) => {
        try {
            DatabaseService_1.default.getInstance().upsertFriendRequest(zaloId, request, direction);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:removeFriendRequest', async (_event, { zaloId, userId, direction }) => {
        try {
            DatabaseService_1.default.getInstance().removeFriendRequest(zaloId, userId, direction);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:addFriend', async (_event, { zaloId, friend }) => {
        try {
            DatabaseService_1.default.getInstance().addFriend(zaloId, friend);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:removeFriend', async (_event, { zaloId, userId }) => {
        try {
            DatabaseService_1.default.getInstance().removeFriend(zaloId, userId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getMessagesByType', async (_event, { zaloId, threadId, msgType, limit = 100 }) => {
        try {
            const messages = DatabaseService_1.default.getInstance().getMessagesByType(zaloId, threadId, msgType, limit);
            return { success: true, messages };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Pinned Messages ──────────────────────────────────────────────────────
    electron_1.ipcMain.handle('db:getPinnedMessages', async (_event, { zaloId, threadId }) => {
        try {
            const pins = DatabaseService_1.default.getInstance().getPinnedMessages(zaloId, threadId);
            return { success: true, pins };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:pinMessage', async (_event, { zaloId, threadId, pin }) => {
        try {
            DatabaseService_1.default.getInstance().pinMessage(zaloId, threadId, pin);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:unpinMessage', async (_event, { zaloId, threadId, msgId }) => {
        try {
            DatabaseService_1.default.getInstance().unpinMessage(zaloId, threadId, msgId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:bringPinnedToTop', async (_event, { zaloId, threadId, msgId }) => {
        try {
            DatabaseService_1.default.getInstance().bringPinnedToTop(zaloId, threadId, msgId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Local Quick Messages ──────────────────────────────────────────────
    electron_1.ipcMain.handle('db:getLocalQuickMessages', async (_event, { zaloId }) => {
        try {
            const items = DatabaseService_1.default.getInstance().getLocalQuickMessages(zaloId);
            return { success: true, items };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:upsertLocalQuickMessage', async (_event, { zaloId, item }) => {
        try {
            const id = DatabaseService_1.default.getInstance().upsertLocalQuickMessage(zaloId, item);
            DatabaseService_1.default.getInstance()['save']?.();
            return { success: true, id };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:deleteLocalQuickMessage', async (_event, { zaloId, id }) => {
        try {
            DatabaseService_1.default.getInstance().deleteLocalQuickMessage(zaloId, id);
            DatabaseService_1.default.getInstance()['save']?.();
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:bulkReplaceLocalQuickMessages', async (_event, { zaloId, items }) => {
        try {
            DatabaseService_1.default.getInstance().bulkReplaceLocalQuickMessages(zaloId, items);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:cloneLocalQuickMessages', async (_event, { sourceZaloId, targetZaloId }) => {
        try {
            const count = DatabaseService_1.default.getInstance().cloneLocalQuickMessages(sourceZaloId, targetZaloId);
            return { success: true, count };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getAllLocalQuickMessages', async () => {
        try {
            const items = DatabaseService_1.default.getInstance().getAllLocalQuickMessages();
            return { success: true, items };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:setLocalQMActive', async (_event, { id, isActive }) => {
        try {
            DatabaseService_1.default.getInstance().setLocalQMActive(id, isActive);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:setLocalQMOrder', async (_event, { id, order }) => {
        try {
            DatabaseService_1.default.getInstance().setLocalQMOrder(id, order);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Local Labels ──────────────────────────────────────────────────────
    electron_1.ipcMain.handle('db:getLocalLabels', async (_event, { zaloId }) => {
        try {
            const labels = DatabaseService_1.default.getInstance().getLocalLabels(zaloId);
            return { success: true, labels };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:upsertLocalLabel', async (_event, { label }) => {
        try {
            const id = DatabaseService_1.default.getInstance().upsertLocalLabel(label);
            return { success: true, id };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:deleteLocalLabel', async (_event, { id }) => {
        try {
            DatabaseService_1.default.getInstance().deleteLocalLabel(id);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:setLocalLabelActive', async (_event, { id, isActive }) => {
        try {
            DatabaseService_1.default.getInstance().setLocalLabelActive(id, isActive);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:setLocalLabelOrder', async (_event, { id, order }) => {
        try {
            DatabaseService_1.default.getInstance().setLocalLabelOrder(id, order);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:cloneLocalLabels', async (_event, { sourceZaloId, targetZaloId }) => {
        try {
            const count = DatabaseService_1.default.getInstance().cloneLocalLabels(sourceZaloId, targetZaloId);
            return { success: true, count };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
    electron_1.ipcMain.handle('db:getLocalLabelThreads', async (_event, { zaloId }) => {
        try {
            const threads = DatabaseService_1.default.getInstance().getLocalLabelThreads(zaloId);
            return { success: true, threads };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:assignLocalLabelToThread', async (_event, { zaloId, labelId, threadId, threadType, labelText, labelColor, labelEmoji }) => {
        try {
            DatabaseService_1.default.getInstance().assignLocalLabelToThread(zaloId, labelId, threadId);
            // Centralized workflow label event emission
            try {
                WorkflowEngineService_1.default.getInstance().triggerLabelEvent({
                    zaloId, threadId,
                    threadType: threadType ?? 0,
                    labelId,
                    labelText: labelText || '',
                    labelColor: labelColor || '',
                    labelEmoji: labelEmoji || '',
                    labelSource: 'local',
                    action: 'assigned',
                });
            }
            catch (err) {
                Logger_1.default.error(`[databaseIpc] assignLocalLabel workflow event error: ${err.message}`);
            }
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:removeLocalLabelFromThread', async (_event, { zaloId, labelId, threadId, threadType, labelText, labelColor, labelEmoji }) => {
        try {
            DatabaseService_1.default.getInstance().removeLocalLabelFromThread(zaloId, labelId, threadId);
            // Centralized workflow label event emission
            try {
                WorkflowEngineService_1.default.getInstance().triggerLabelEvent({
                    zaloId, threadId,
                    threadType: threadType ?? 0,
                    labelId,
                    labelText: labelText || '',
                    labelColor: labelColor || '',
                    labelEmoji: labelEmoji || '',
                    labelSource: 'local',
                    action: 'removed',
                });
            }
            catch (err) {
                Logger_1.default.error(`[databaseIpc] removeLocalLabel workflow event error: ${err.message}`);
            }
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getThreadLocalLabels', async (_event, { zaloId, threadId }) => {
        try {
            const labels = DatabaseService_1.default.getInstance().getThreadLocalLabels(zaloId, threadId);
            return { success: true, labels };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Contact Flags (mute / others) ───────────────────────────────────
    electron_1.ipcMain.handle('db:setContactFlags', async (_event, { zaloId, contactId, flags }) => {
        try {
            DatabaseService_1.default.getInstance().setContactFlags(zaloId, contactId, flags);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getContactsWithFlags', async (_event, { zaloId }) => {
        try {
            const rows = DatabaseService_1.default.getInstance().getContactsWithFlags(zaloId);
            return { success: true, rows };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:setContactAlias', async (_event, { zaloId, contactId, alias }) => {
        try {
            DatabaseService_1.default.getInstance().setContactAlias(zaloId, contactId, alias);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Message Drafts ───────────────────────────────────────────────────
    electron_1.ipcMain.handle('db:upsertDraft', async (_event, { zaloId, threadId, content }) => {
        try {
            DatabaseService_1.default.getInstance().upsertDraft(zaloId, threadId, content);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:deleteDraft', async (_event, { zaloId, threadId }) => {
        try {
            DatabaseService_1.default.getInstance().deleteDraft(zaloId, threadId);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getDraft', async (_event, { zaloId, threadId }) => {
        try {
            const draft = DatabaseService_1.default.getInstance().getDraft(zaloId, threadId);
            return { success: true, draft };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:getDrafts', async (_event, { zaloId }) => {
        try {
            const drafts = DatabaseService_1.default.getInstance().getDrafts(zaloId);
            return { success: true, drafts };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:deleteOldDrafts', async (_event, { days }) => {
        try {
            DatabaseService_1.default.getInstance().deleteOldDrafts(days);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Bank Cards ─────────────────────────────────────────────────────
    electron_1.ipcMain.handle('db:getBankCards', async (_event, { zaloId }) => {
        try {
            const cards = DatabaseService_1.default.getInstance().getBankCards(zaloId);
            return { success: true, cards };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:upsertBankCard', async (_event, { zaloId, card }) => {
        try {
            const id = DatabaseService_1.default.getInstance().upsertBankCard(zaloId, card);
            return { success: true, id };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:deleteBankCard', async (_event, { zaloId, id }) => {
        try {
            DatabaseService_1.default.getInstance().deleteBankCard(zaloId, id);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    // ─── Local Pinned Conversations ──────────────────────────────────────
    electron_1.ipcMain.handle('db:getLocalPinnedConversations', async (_event, { zaloId }) => {
        try {
            const threadIds = DatabaseService_1.default.getInstance().getLocalPinnedConversations(zaloId);
            return { success: true, threadIds };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('db:setLocalPinnedConversation', async (_event, { zaloId, threadId, isPinned }) => {
        try {
            DatabaseService_1.default.getInstance().setLocalPinnedConversation(zaloId, threadId, isPinned);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
}
//# sourceMappingURL=databaseIpc.js.map