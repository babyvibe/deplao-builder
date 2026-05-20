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
exports.registerFileIpc = registerFileIpc;
const electron_1 = require("electron");
const FileStorageService_1 = __importDefault(require("../../src/services/FileStorageService"));
const Logger_1 = __importDefault(require("../../src/utils/Logger"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Lấy đường dẫn ffmpeg: ưu tiên ffmpeg-static, fallback về PATH */
function getFfmpegBin() {
    try {
        // ffmpeg-static trả về path tới binary
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ffmpegStatic = require('ffmpeg-static');
        if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
            return ffmpegStatic;
        }
    }
    catch { /* not installed */ }
    return 'ffmpeg'; // fallback PATH
}
function registerFileIpc() {
    electron_1.ipcMain.handle('file:openDialog', async (_event, options) => {
        try {
            const result = await electron_1.dialog.showOpenDialog({
                properties: ['openFile', ...(options?.multiSelect ? ['multiSelections'] : [])],
                filters: options?.filters || [
                    { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            });
            return { success: true, filePaths: result.filePaths, canceled: result.canceled };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('file:saveImage', async (_event, { zaloId, url, filename }) => {
        try {
            const localPath = await FileStorageService_1.default.downloadImage(zaloId, url, filename);
            return { success: true, localPath };
        }
        catch (error) {
            Logger_1.default.error(`[fileIpc] saveImage error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('file:getAppDataPath', async () => {
        return { success: true, path: electron_1.app.getPath('userData') };
    });
    electron_1.ipcMain.handle('file:openPath', async (_event, filePath) => {
        try {
            // Resolve relative paths (stored in DB as folder-agnostic relative paths)
            const resolved = FileStorageService_1.default.resolveAbsolutePath(filePath);
            await electron_1.shell.openPath(resolved);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    /** Mở thư mục chứa file và highlight file đó (Explorer/Finder) */
    electron_1.ipcMain.handle('file:showItemInFolder', async (_event, filePath) => {
        try {
            // Resolve relative paths (stored in DB as folder-agnostic relative paths)
            const resolved = FileStorageService_1.default.resolveAbsolutePath(filePath);
            electron_1.shell.showItemInFolder(resolved);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    /**
     * Lưu file về máy: hiện dialog chọn vị trí, copy file local hoặc download từ URL
     */
    electron_1.ipcMain.handle('file:saveAs', async (_event, params) => {
        try {
            const ext = path.extname(params.defaultName) || '';
            const extNoDot = ext.replace('.', '').toLowerCase();
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'avif'];
            const videoExts = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv'];
            const filters = [];
            if (imageExts.includes(extNoDot)) {
                filters.push({ name: 'Hình ảnh', extensions: imageExts });
            }
            else if (videoExts.includes(extNoDot)) {
                filters.push({ name: 'Video', extensions: videoExts });
            }
            filters.push({ name: 'Tất cả file', extensions: ['*'] });
            const result = await electron_1.dialog.showSaveDialog({
                defaultPath: params.defaultName,
                filters,
                title: 'Lưu file về máy',
            });
            if (result.canceled || !result.filePath) {
                return { success: true, canceled: true };
            }
            const destPath = result.filePath;
            const resolvedLocalPath = params.localPath ? FileStorageService_1.default.resolveAbsolutePath(params.localPath) : '';
            if (resolvedLocalPath && fs.existsSync(resolvedLocalPath)) {
                fs.copyFileSync(resolvedLocalPath, destPath);
            }
            else if (params.remoteUrl) {
                if (!params.zaloId)
                    return { success: false, error: 'zaloId required for remote download' };
                const tmpRelPath = await FileStorageService_1.default.downloadImage(params.zaloId, params.remoteUrl, params.defaultName, params.cookiesJson, params.userAgent);
                const tmpPath = tmpRelPath ? FileStorageService_1.default.resolveAbsolutePath(tmpRelPath) : '';
                if (tmpPath && fs.existsSync(tmpPath)) {
                    fs.copyFileSync(tmpPath, destPath);
                }
                else {
                    return { success: false, error: 'Không thể tải file từ server' };
                }
            }
            else {
                return { success: false, error: 'Không có nguồn file để lưu' };
            }
            return { success: true, savedPath: destPath };
        }
        catch (error) {
            Logger_1.default.error(`[fileIpc] saveAs error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });
    /** Lưu base64 data thành file tạm để gửi ảnh clipboard */
    electron_1.ipcMain.handle('file:saveTempBlob', async (_event, { base64, ext }) => {
        try {
            const tmpDir = path.join(electron_1.app.getPath('temp'), 'deplao-clipboard');
            if (!fs.existsSync(tmpDir))
                fs.mkdirSync(tmpDir, { recursive: true });
            const filename = `paste_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext || 'png'}`;
            const filePath = path.join(tmpDir, filename);
            const buffer = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64');
            fs.writeFileSync(filePath, buffer);
            return { success: true, filePath };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    });
    /**
     * Lấy metadata video (duration, width, height) và extract thumbnail dùng ffmpeg-static.
     */
    electron_1.ipcMain.handle('file:getVideoMeta', async (_event, { filePath: videoPath }) => {
        try {
            // Resolve relative paths stored in DB
            const resolvedVideoPath = FileStorageService_1.default.resolveAbsolutePath(videoPath);
            if (!fs.existsSync(resolvedVideoPath))
                return { success: false, error: 'File not found' };
            const tmpDir = path.join(electron_1.app.getPath('temp'), 'deplao-videometa');
            if (!fs.existsSync(tmpDir))
                fs.mkdirSync(tmpDir, { recursive: true });
            const thumbPath = path.join(tmpDir, `thumb_${Date.now()}.jpg`);
            let duration = 0;
            let width = 0;
            let height = 0;
            let gotThumb = false;
            const ffmpegBin = getFfmpegBin();
            Logger_1.default.info(`[fileIpc] getVideoMeta using ffmpeg: ${ffmpegBin}`);
            const { execFileSync, spawnSync } = await Promise.resolve().then(() => __importStar(require('child_process')));
            // ── Probe metadata bằng ffmpeg -i (stderr) ──────────────────
            try {
                // ffmpeg -i in ra info vào stderr, không cần output file
                const probe = spawnSync(ffmpegBin, ['-i', resolvedVideoPath, '-hide_banner'], {
                    timeout: 10000,
                    encoding: 'utf8',
                });
                const stderr = (probe.stderr || '') + (probe.stdout || '');
                // Duration: HH:MM:SS.ms  e.g. "Duration: 00:00:05.23"
                const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
                if (durMatch) {
                    duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
                }
                // Video stream: e.g. "Video: h264, ..., 1280x720"
                const dimMatch = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
                if (dimMatch) {
                    width = parseInt(dimMatch[1]);
                    height = parseInt(dimMatch[2]);
                }
                Logger_1.default.info(`[fileIpc] probed: duration=${duration}s w=${width} h=${height}`);
            }
            catch (e) {
                Logger_1.default.warn(`[fileIpc] probe failed: ${e.message}`);
            }
            // ── Extract thumbnail ────────────────────────────────────────
            const tryExtract = (seekSec) => {
                try {
                    // -ss AFTER -i = accurate seek (slow but correct frames)
                    execFileSync(ffmpegBin, [
                        '-y',
                        '-i', resolvedVideoPath,
                        '-ss', String(seekSec),
                        '-vframes', '1',
                        '-q:v', '2',
                        '-vf', 'scale=480:-2',
                        thumbPath,
                    ], { timeout: 20000 });
                    const ok = fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 500;
                    Logger_1.default.info(`[fileIpc] tryExtract seek=${seekSec}s → ok=${ok} size=${ok ? fs.statSync(thumbPath).size : 0}`);
                    return ok;
                }
                catch (e) {
                    Logger_1.default.warn(`[fileIpc] tryExtract seek=${seekSec}s failed: ${e.message}`);
                    return false;
                }
            };
            // Thử seek tại 10% duration (ít nhất 1s, tối đa 5s), fallback về 0s
            const seek1 = duration > 1 ? Math.min(Math.max(Math.floor(duration * 0.1), 1), 5) : 0;
            gotThumb = tryExtract(seek1);
            if (!gotThumb && seek1 > 0) {
                gotThumb = tryExtract(0);
            }
            return {
                success: true,
                thumbPath: gotThumb ? thumbPath : '',
                duration: Math.round(duration),
                width,
                height,
            };
        }
        catch (error) {
            Logger_1.default.error(`[fileIpc] getVideoMeta error: ${error.message}`);
            return { success: false, error: error.message, thumbPath: '', duration: 0, width: 0, height: 0 };
        }
    });
}
//# sourceMappingURL=fileIpc.js.map