import { ipcMain, dialog, shell, app, net } from 'electron';
import FileStorageService from '../../src/services/file/FileStorageService';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import MediaCacheService from '../../src/services/cache/MediaCacheService';
import Logger from '../../src/utils/Logger';
import * as fs from 'fs';
import * as path from 'path';

/** Repair queue: dedup concurrent repairs for the same file */
const pendingRepairs = new Map<string, Promise<{ success: boolean; newLocalPath?: string; error?: string }>>();

/** Lấy đường dẫn ffmpeg: ưu tiên ffmpeg-static, fallback về PATH */
function getFfmpegBin(): string {
    try {
        // ffmpeg-static trả về path tới binary
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        let ffmpegStatic = require('ffmpeg-static') as string;
        // Fix path when running inside Electron asar archive
        if (ffmpegStatic && ffmpegStatic.includes('app.asar') && !ffmpegStatic.includes('app.asar.unpacked')) {
            ffmpegStatic = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
        }
        if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
            return ffmpegStatic;
        }
    } catch { /* not installed */ }
    return 'ffmpeg'; // fallback PATH
}

export function registerFileIpc() {
    // Init MediaCacheService cho employee mode
    try {
        MediaCacheService.getInstance().init();
    } catch {}

    ipcMain.handle('file:openDialog', async (_event, options: any) => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openFile', ...(options?.multiSelect ? ['multiSelections' as const] : [])],
                filters: options?.filters || [
                    { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            });
            return { success: true, filePaths: result.filePaths, canceled: result.canceled };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('file:saveImage', async (_event, { zaloId, url, filename }) => {
        try {
            const localPath = await FileStorageService.downloadImage(zaloId, url, filename);
            return { success: true, localPath };
        } catch (error: any) {
            Logger.error(`[fileIpc] saveImage error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('file:getAppDataPath', async () => {
        return { success: true, path: app.getPath('userData') };
    });

    ipcMain.handle('file:openPath', async (_event, filePath: string) => {
        try {
            // Resolve relative paths (stored in DB as folder-agnostic relative paths)
            const resolved = FileStorageService.resolveAbsolutePath(filePath);
            await shell.openPath(resolved);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    /** Mở thư mục chứa file và highlight file đó (Explorer/Finder) */
    ipcMain.handle('file:showItemInFolder', async (_event, filePath: string) => {
        try {
            // Resolve relative paths (stored in DB as folder-agnostic relative paths)
            const resolved = FileStorageService.resolveAbsolutePath(filePath);
            shell.showItemInFolder(resolved);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    /**
     * Lưu file về máy: hiện dialog chọn vị trí, copy file local hoặc download từ URL
     */
    ipcMain.handle('file:saveAs', async (_event, params: {
        localPath?: string;
        remoteUrl?: string;
        defaultName: string;
        zaloId?: string;
        cookiesJson?: string;
        userAgent?: string;
    }) => {
        try {
            const ext = path.extname(params.defaultName) || '';
            const extNoDot = ext.replace('.', '').toLowerCase();
            const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'avif'];
            const videoExts = ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv'];

            const filters: Electron.FileFilter[] = [];
            if (imageExts.includes(extNoDot)) {
                filters.push({ name: 'Hình ảnh', extensions: imageExts });
            } else if (videoExts.includes(extNoDot)) {
                filters.push({ name: 'Video', extensions: videoExts });
            }
            filters.push({ name: 'Tất cả file', extensions: ['*'] });

            const result = await dialog.showSaveDialog({
                defaultPath: params.defaultName,
                filters,
                title: 'Lưu file về máy',
            });

            if (result.canceled || !result.filePath) {
                return { success: true, canceled: true };
            }

            const destPath = result.filePath;

            const resolvedLocalPath = params.localPath ? FileStorageService.resolveAbsolutePath(params.localPath) : '';
            const isImageExt = imageExts.includes(extNoDot);

            // Try local file first - validate if it's an image
            let localValid = false;
            if (resolvedLocalPath && fs.existsSync(resolvedLocalPath)) {
                if (isImageExt) {
                    const v = FileStorageService.validateImageFile(resolvedLocalPath);
                    localValid = v.valid;
                    if (!v.valid) {
                        Logger.warn(`[fileIpc] saveAs: local file corrupted (${v.reason}), will try remote`);
                        try { fs.unlinkSync(resolvedLocalPath); } catch {}
                    }
                } else {
                    // Non-image: chỉ check size > 0
                    try { localValid = fs.statSync(resolvedLocalPath).size > 0; } catch {}
                }
            }

            if (localValid && resolvedLocalPath) {
                fs.copyFileSync(resolvedLocalPath, destPath);
            } else if (params.remoteUrl) {
                if (!params.zaloId) return { success: false, error: 'zaloId required for remote download' };
                const tmpRelPath = await FileStorageService.downloadImage(
                    params.zaloId, params.remoteUrl, params.defaultName,
                    params.cookiesJson, params.userAgent,
                );
                const tmpPath = tmpRelPath ? FileStorageService.resolveAbsolutePath(tmpRelPath) : '';
                if (tmpPath && fs.existsSync(tmpPath)) {
                    fs.copyFileSync(tmpPath, destPath);
                } else {
                    return { success: false, error: 'Không thể tải file từ server' };
                }
            } else {
                return { success: false, error: 'Không có nguồn file để lưu' };
            }

            return { success: true, savedPath: destPath };
        } catch (error: any) {
            Logger.error(`[fileIpc] saveAs error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    /** Lưu base64 data thành file tạm để gửi ảnh clipboard */
    ipcMain.handle('file:saveTempBlob', async (_event, { base64, ext, filename }: { base64: string; ext: string; filename?: string }) => {
        try {
            const tmpDir = path.join(app.getPath('temp'), 'deplao-clipboard');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            // Preserve original filename if provided, otherwise generate random name
            const safeName = filename
                ? `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
                : `paste_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext || 'png'}`;
            const filePath = path.join(tmpDir, safeName);
            const buffer = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64');
            fs.writeFileSync(filePath, buffer);
            return { success: true, filePath };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    /**
     * Đọc ảnh từ local path hoặc remote URL và trả về base64.
     * Dùng main process để tránh CORS khi fetch remote URL từ renderer.
     */
    ipcMain.handle('file:readImageAsBase64', async (_event, { localPath: lp, remoteUrl }: { localPath?: string; remoteUrl?: string }) => {
        try {
            if (lp) {
                const resolved = FileStorageService.resolveAbsolutePath(lp);
                if (fs.existsSync(resolved)) {
                    const buffer = fs.readFileSync(resolved);
                    const ext = path.extname(resolved).replace('.', '').toLowerCase() || 'jpg';
                    const mimeMap: Record<string, string> = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
                    return { success: true, base64: buffer.toString('base64'), mimeType: mimeMap[ext] || 'image/jpeg' };
                }
            }
            if (remoteUrl) {
                const response = await net.fetch(remoteUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                });
                if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const ct = response.headers.get('content-type') || '';
                const mimeType = ct.startsWith('image/') ? ct.split(';')[0].trim() : 'image/jpeg';
                return { success: true, base64: buffer.toString('base64'), mimeType };
            }
            return { success: false, error: 'No source provided' };
        } catch (error: any) {
            Logger.error(`[fileIpc] readImageAsBase64 error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    /**
     * Lấy metadata video (duration, width, height) và extract thumbnail dùng ffmpeg-static.
     */
    ipcMain.handle('file:getVideoMeta', async (_event, { filePath: videoPath }: { filePath: string }) => {
        try {
            // Resolve relative paths stored in DB
            const resolvedVideoPath = FileStorageService.resolveAbsolutePath(videoPath);
            if (!fs.existsSync(resolvedVideoPath)) return { success: false, error: 'File not found' };

            const tmpDir = path.join(app.getPath('temp'), 'deplao-videometa');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            const thumbPath = path.join(tmpDir, `thumb_${Date.now()}.jpg`);

            let duration = 0;
            let width = 0;
            let height = 0;
            let gotThumb = false;

            const ffmpegBin = getFfmpegBin();
            Logger.info(`[fileIpc] getVideoMeta using ffmpeg: ${ffmpegBin}`);

            const { execFileSync, spawnSync } = await import('child_process');

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
                Logger.info(`[fileIpc] probed: duration=${duration}s w=${width} h=${height}`);
            } catch (e: any) {
                Logger.warn(`[fileIpc] probe failed: ${e.message}`);
            }

            // ── Extract thumbnail ────────────────────────────────────────
            const tryExtract = (seekSec: number): boolean => {
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
                    Logger.info(`[fileIpc] tryExtract seek=${seekSec}s → ok=${ok} size=${ok ? fs.statSync(thumbPath).size : 0}`);
                    return ok;
                } catch (e: any) {
                    Logger.warn(`[fileIpc] tryExtract seek=${seekSec}s failed: ${e.message}`);
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
        } catch (error: any) {
            Logger.error(`[fileIpc] getVideoMeta error: ${error.message}`);
            return { success: false, error: error.message, thumbPath: '', duration: 0, width: 0, height: 0 };
        }
    });

    /**
     * Repair ảnh lỗi: xóa file hỏng, tải lại từ CDN backup URL, cập nhật DB.
     * Renderer gọi khi img onError fire (MediaBubble / MediaViewer).
     */
    ipcMain.handle('file:repairImage', async (_event, params: {
        zaloId: string;
        msgId: string;
        threadId?: string;
        localPath?: string;
        remoteUrl?: string;
    }) => {
        const { zaloId, msgId, threadId, localPath, remoteUrl } = params;
        if (!zaloId || !msgId) return { success: false, error: 'Missing zaloId or msgId' };

        // Dedup: nếu đang repair file này rồi → chờ kết quả hiện tại
        const queueKey = localPath || `${zaloId}:${msgId}`;
        const existing = pendingRepairs.get(queueKey);
        if (existing) return existing;

        const repairPromise = (async () => {
            try {
                // 1. Xóa file cũ nếu tồn tại
                if (localPath) {
                    const absPath = FileStorageService.resolveAbsolutePath(localPath);
                    if (absPath && fs.existsSync(absPath)) {
                        try { fs.unlinkSync(absPath); } catch {}
                    }
                }

                // 2. Lấy URL ảnh: ưu tiên remoteUrl, fallback lookup DB
                let imgUrl = remoteUrl || '';
                if (!imgUrl) {
                    try {
                        const row = DatabaseService.getInstance().getMessageById(zaloId, msgId);
                        if (row?.content) {
                            const contentRaw = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
                            imgUrl = DatabaseService.extractImageUrlFromContent(contentRaw) || '';
                        }
                    } catch (e: any) {
                        Logger.warn(`[fileIpc] repairImage: DB lookup failed: ${e.message}`);
                    }
                }

                if (!imgUrl) return { success: false, error: 'No image URL available' };

                // 3. Tải lại ảnh
                const newLocalPath = await FileStorageService.downloadImage(zaloId, imgUrl);
                if (!newLocalPath) return { success: false, error: 'Download returned empty (CDN expired?)' };

                // 4. Cập nhật DB
                DatabaseService.getInstance().updateLocalPaths(zaloId, msgId, { main: newLocalPath });

                // 5. Emit event để renderer refresh
                const resolvedThreadId = threadId || (() => {
                    try {
                        const row = DatabaseService.getInstance().getMessageById(zaloId, msgId);
                        return row?.thread_id || '';
                    } catch { return ''; }
                })();
                if (resolvedThreadId) {
                    EventBroadcaster.sendDirect('event:localPath', {
                        zaloId, msgId, threadId: resolvedThreadId,
                        localPaths: { main: newLocalPath },
                    });
                }

                Logger.log(`[fileIpc] repairImage success: ${msgId} → ${newLocalPath}`);
                return { success: true, newLocalPath };
            } catch (error: any) {
                Logger.error(`[fileIpc] repairImage error: ${error.message}`);
                return { success: false, error: error.message };
            }
        })();

        pendingRepairs.set(queueKey, repairPromise);
        repairPromise.finally(() => pendingRepairs.delete(queueKey));
        return repairPromise;
    });

    /**
     * Batch validate ảnh local: kiểm tra nhiều ảnh cùng lúc, trả về danh sách ảnh lỗi.
     * Renderer gọi khi load messages để tìm và repair ảnh hỏng từ trước.
     */
    ipcMain.handle('file:validateLocalImages', async (_event, items: Array<{
        zaloId: string;
        msgId: string;
        threadId?: string;
        localPath: string;
        remoteUrl?: string;
    }>) => {
        const corrupted: Array<{ zaloId: string; msgId: string; threadId?: string; localPath: string; remoteUrl?: string; reason: string }> = [];
        if (!items?.length) return { success: true, corrupted };

        for (const item of items) {
            try {
                const absPath = FileStorageService.resolveAbsolutePath(item.localPath);
                if (!absPath) continue;
                const ext = path.extname(absPath).replace('.', '').toLowerCase();
                const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'avif'];
                if (!imageExts.includes(ext)) continue; // Chỉ validate ảnh

                const v = FileStorageService.validateImageFile(absPath);
                if (!v.valid) {
                    corrupted.push({ ...item, reason: v.reason || 'unknown' });
                    // Xóa file lỗi ngay
                    try { fs.unlinkSync(absPath); } catch {}
                }
            } catch {}
        }

        return { success: true, corrupted };
    });

    /**
     * MediaCache: resolve URL với cache-first
     * Employee: kiểm tra cache local trước, nếu miss thì download background + trả về boss URL
     */
    ipcMain.handle('media:resolveUrl', async (_event, { bossUrl, mediaType }: { bossUrl: string; mediaType?: string }) => {
        try {
            const cache = MediaCacheService.getInstance();
            if (!bossUrl) return { success: true, displayUrl: '', fromCache: false };

            // 1. Kiểm tra MediaCacheService trước
            const cached = cache.hasCache(bossUrl);
            if (cached) {
                const result = await cache.resolveUrl(bossUrl, (mediaType || 'image') as any);
                return { success: true, displayUrl: result.displayUrl, fromCache: true };
            }

            // 2. Kiểm tra workspace media directory (file đã download từ trước)
            //    Boss URL pattern: /api/media/{path} → map về workspace media/
            try {
                const mediaPath = bossUrl.includes('/api/media/')
                    ? 'media/' + bossUrl.split('/api/media/')[1].split('?')[0]
                    : '';
                if (mediaPath) {
                    const absPath = FileStorageService.resolveAbsolutePath(mediaPath);
                    if (absPath && fs.existsSync(absPath)) {
                        // File tồn tại trong workspace → dùng file:// URL
                        const normalized = absPath.replace(/\\/g, '/');
                        const fileUrl = `file:///${normalized.startsWith('/') ? '' : '/'}${normalized}`;
                        Logger.log(`[fileIpc] media:resolveUrl → workspace hit: ${mediaPath}`);
                        return { success: true, displayUrl: fileUrl, fromCache: true };
                    }
                }
            } catch {}

            // 3. Cache miss → download background từ Boss
            const result = await cache.resolveUrl(bossUrl, (mediaType || 'image') as any);
            return { success: true, displayUrl: result.displayUrl, fromCache: result.fromCache };
        } catch (err: any) {
            Logger.error(`[fileIpc] media:resolveUrl error: ${err.message}`);
            return { success: false, displayUrl: bossUrl, fromCache: false };
        }
    });

    /** Check xem URL đã được cache hoặc có trong workspace media chưa (sync, nhanh) */
    ipcMain.handle('media:hasCache', async (_event, { bossUrl }: { bossUrl: string }) => {
        try {
            const cache = MediaCacheService.getInstance();
            if (cache.hasCache(bossUrl)) return { success: true, cached: true };
            // Check workspace media directory
            const mediaPath = bossUrl.includes('/api/media/')
                ? 'media/' + bossUrl.split('/api/media/')[1].split('?')[0]
                : '';
            if (mediaPath) {
                const absPath = FileStorageService.resolveAbsolutePath(mediaPath);
                if (absPath && fs.existsSync(absPath)) {
                    return { success: true, cached: true };
                }
            }
            return { success: true, cached: false };
        } catch {
            return { success: true, cached: false };
        }
    });

    /**
     * Batch preload: nhận danh sách Boss URLs, trigger download background
     * Trả về ngay, không đợi download hoàn tất
     */
    ipcMain.handle('media:preloadBatch', async (_event, { urls }: { urls: string[] }) => {
        try {
            const cache = MediaCacheService.getInstance();
            let triggered = 0;
            for (const url of urls) {
                if (!url) continue;
                // Skip nếu đã có trong cache hoặc workspace media
                if (cache.hasCache(url)) continue;
                const mediaPath = url.includes('/api/media/')
                    ? 'media/' + url.split('/api/media/')[1].split('?')[0]
                    : '';
                if (mediaPath) {
                    try {
                        const absPath = FileStorageService.resolveAbsolutePath(mediaPath);
                        if (absPath && require('fs').existsSync(absPath)) continue;
                    } catch {}
                }
                // Cache miss → download background
                cache.resolveUrl(url, 'image').catch(() => {});
                triggered++;
            }
            return { success: true, triggered };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

}

