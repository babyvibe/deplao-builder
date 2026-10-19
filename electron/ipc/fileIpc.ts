import { ipcMain, dialog, shell, app, net } from 'electron';
import FileStorageService from '../../src/services/file/FileStorageService';
import DatabaseService from '../../src/services/database/DatabaseService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import MediaCacheService from '../../src/services/cache/MediaCacheService';
import { bossAuthHeaders } from '../../src/services/http/bossSessionAuth';
import { classifyMediaError, probeMediaUrl } from '../../src/services/file/MediaExpiryService';
import { toZaloJpgUrl } from '../../src/utils/zaloImageUrl';
import Logger from '../../src/utils/Logger';
import * as fs from 'fs';
import * as path from 'path';

/** Repair queue: dedup concurrent repairs for the same file */
const pendingRepairs = new Map<string, Promise<{ success: boolean; newLocalPath?: string; expired?: boolean; error?: string }>>();
/** Faststart repair queue: dedup concurrent ensureFaststart calls for the same file */
const pendingFaststart = new Map<string, Promise<{ success: boolean; fixed?: boolean; reason?: string; error?: string }>>();

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
            } else if (params.localPath) {
                // Employee mode fallback: local path không tồn tại (path từ Boss)
                // → chuyển thành Boss REST URL và download qua HttpClientService
                try {
                    const { default: WorkspaceManager } = require('../../src/utils/WorkspaceManager');
                    const ws = WorkspaceManager.getInstance().getActiveWorkspace();
                    if (ws?.type === 'remote' && ws.bossUrl && ws.token) {
                        // Build boss REST URL từ local path (giống toLocalMediaUrl)
                        const normalized = params.localPath.replace(/\\/g, '/');
                        const mediaMatch = normalized.match(/(?:^|\/)(media|_uploads|avatar)\/(.+)/);
                        let bossUrl = '';
                        if (mediaMatch) {
                            bossUrl = `${ws.bossUrl.replace(/\/+$/, '')}/api/${mediaMatch[1]}/${mediaMatch[2]}`;
                        } else {
                            const filename = normalized.split('/').pop() || params.defaultName;
                            bossUrl = `${ws.bossUrl.replace(/\/+$/, '')}/api/media/external/${encodeURIComponent(normalized)}`;
                        }
                        // Download từ Boss
                        const response = await fetch(bossUrl, {
                            headers: { 'Authorization': `Bearer ${ws.token}` },
                            signal: AbortSignal.timeout(120000),
                        });
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const buffer = Buffer.from(await response.arrayBuffer());
                        fs.writeFileSync(destPath, buffer);
                    } else {
                        return { success: false, error: 'Không có nguồn file để lưu' };
                    }
                } catch (e: any) {
                    Logger.error(`[fileIpc] saveAs employee fallback error: ${e.message}`);
                    return { success: false, error: 'Không thể tải file từ Boss: ' + e.message };
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
                    // URL file của Boss (nhân viên) cần token phiên; URL khác (CDN) không gắn gì
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...bossAuthHeaders(remoteUrl) },
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
        /** true = bỏ qua cờ "đã hết hạn" (người dùng bấm Thử tải lại) */
        force?: boolean;
    }) => {
        const { zaloId, msgId, threadId, localPath, remoteUrl, force } = params;
        if (!zaloId || !msgId) return { success: false, error: 'Missing zaloId or msgId' };
        // Đã biết ảnh hết hạn → không gọi mạng nữa (tránh tải lại liên tục mỗi lần render)
        if (!force && DatabaseService.getInstance().isMediaExpired(zaloId, msgId)) {
            return { success: false, expired: true, error: 'Media expired' };
        }

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
                // Ảnh JPEG XL của Zalo → bản JPG (Chromium không hiển thị JXL)
                imgUrl = toZaloJpgUrl(imgUrl);

                // 3. Tải lại bằng session của đúng tài khoản. CDN Zalo có thể
                // trả 403 cho request không mang Cookie/User-Agent dù URL vẫn mở
                // được trong trình duyệt.
                const account = DatabaseService.getInstance().getAccounts()
                    .find(item => item.zalo_id === zaloId);
                let newLocalPath = '';
                try {
                    newLocalPath = await FileStorageService.downloadImage(
                        zaloId,
                        imgUrl,
                        undefined,
                        account?.cookies,
                        account?.user_agent,
                    );
                } catch (downloadErr: any) {
                    // CDN trả 404 / host CDN cũ không còn tồn tại → ảnh đã hết hạn
                    if (await classifyMediaError(imgUrl, downloadErr) === 'expired') {
                        DatabaseService.getInstance().setMediaExpired(zaloId, msgId, true);
                        Logger.warn(`[fileIpc] repairImage: ảnh đã hết hạn ${msgId} (${downloadErr?.code || downloadErr?.response?.status || downloadErr?.message})`);
                        return { success: false, expired: true, error: 'Media expired' };
                    }
                    throw downloadErr;
                }
                if (!newLocalPath) {
                    // downloadImage trả rỗng khi CDN trả 401/403/409/410 — chỉ 410 là hết hạn thật,
                    // 401/403 thường do cookie phiên cũ → kiểm tra lại trước khi đánh dấu.
                    if (await probeMediaUrl(imgUrl, account?.cookies, account?.user_agent) === 'expired') {
                        DatabaseService.getInstance().setMediaExpired(zaloId, msgId, true);
                        return { success: false, expired: true, error: 'Media expired' };
                    }
                    return { success: false, error: 'Download returned empty (CDN 401/403/409)' };
                }
                // File tải về phải là ảnh hiển thị được (vd JPEG XL thì Chromium không đọc được). Không báo
                // "thành công" cho file lỗi — nếu không, bubble đổi đường dẫn → lỗi lại → tải lại vô hạn.
                // ('truncated' vẫn cho qua như trước: Chromium hiển thị được JPEG thiếu marker kết thúc.)
                const newAbsPath = FileStorageService.resolveAbsolutePath(newLocalPath);
                const check = FileStorageService.validateImageFile(newAbsPath);
                if (!check.valid && check.reason !== 'truncated') {
                    try { fs.unlinkSync(newAbsPath); } catch {}
                    Logger.warn(`[fileIpc] repairImage: file tải về không hiển thị được (${check.reason}) ${msgId} ← ${imgUrl}`);
                    return { success: false, error: `Ảnh tải về không đọc được (${check.reason})` };
                }
                if (force) DatabaseService.getInstance().setMediaExpired(zaloId, msgId, false);

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
     * Tải media của 1 tin Zalo về máy — dùng khi chuyển tiếp tin chưa tải: zca-js chỉ gửi lại ảnh / GIF / file từ file
     * local, mà tin đồng bộ từ điện thoại / tin cũ không tự tải media. Tên file + key local_paths giống lúc tự tải khi
     * nhận tin (EventBroadcaster) → bubble hiện "đã có trên máy", lần sau dùng lại không tải nữa.
     */
    ipcMain.handle('file:downloadMessageMedia', async (_event, params: {
        zaloId: string;
        msgId: string;
        threadId?: string;
        kind: 'image' | 'gif' | 'file' | 'voice' | 'video';
    }) => {
        const { zaloId, msgId, threadId, kind } = params || ({} as any);
        if (!zaloId || !msgId || !kind) return { success: false, error: 'Thiếu thông tin tin nhắn' };
        const isHttp = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//i.test(value);
        const parseObject = (value: unknown): any => {
            if (value && typeof value === 'object') return value;
            if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return null;
            try { return JSON.parse(value); } catch { return null; }
        };
        try {
            const db = DatabaseService.getInstance();
            const row: any = db.getMessageById(zaloId, String(msgId), threadId);
            if (!row) return { success: false, error: 'Không tìm thấy tin nhắn' };
            const content = parseObject(row.content);
            const contentParams = parseObject(content?.params) || {};
            // Tin định dạng cũ để link ở cột attachments
            const attachment = (() => {
                try {
                    const list = JSON.parse(row.attachments || '[]');
                    return (Array.isArray(list) ? list[0] : list) || {};
                } catch { return {}; }
            })();
            const legacyUrl = [attachment.hd, attachment.href, ...(Array.isArray(attachment.urls) ? attachment.urls : [])].find(isHttp) || '';
            const account = db.getAccounts().find(item => item.zalo_id === zaloId);
            const cookies = account?.cookies;
            const userAgent = account?.user_agent;
            const id = String(row.msg_id || msgId).replace(/[^\w-]/g, '_');

            let localPaths: Record<string, string> = {};
            if (kind === 'image') {
                const url = toZaloJpgUrl(DatabaseService.extractImageUrlFromContent(content) || legacyUrl);
                if (isHttp(url)) {
                    const urlExt = (() => { try { return path.extname(new URL(url).pathname).toLowerCase(); } catch { return ''; } })();
                    const ext = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(urlExt) ? urlExt : '.jpg';
                    const rel = await FileStorageService.downloadImage(zaloId, url, `img_${id}${ext}`, cookies, userAgent);
                    if (rel) localPaths = { main: rel };
                }
            } else if (kind === 'gif') {
                // Link dự phòng ở attachments chỉ dùng cho ảnh / file: tin cũ loại khác để icon / link bản tin ở đó
                const url = [content?.href].find(isHttp);
                const rel = url ? await FileStorageService.downloadImage(zaloId, url, `gif_${id}.gif`, cookies, userAgent) : '';
                if (rel) localPaths = { main: rel };
            } else if (kind === 'voice') {
                const url = [contentParams.m4a, content?.href, attachment.m4a].find(isHttp);
                const rel = url ? await FileStorageService.downloadFile(zaloId, url, `voice_${id}.m4a`, cookies, userAgent) : '';
                if (rel) localPaths = { file: rel };
            } else if (kind === 'video') {
                const url = [content?.href].find(isHttp);
                const rel = url ? await FileStorageService.downloadVideo(zaloId, url, `vid_${id}.mp4`, cookies, userAgent) : '';
                if (rel) localPaths = { file: rel };
            } else if (kind === 'file') {
                const url = [content?.href, legacyUrl].find(isHttp);
                if (url) {
                    const title = String(content?.title || '').trim() || String(row.content || '').replace(/^\[File\]\s*/i, '').trim();
                    const ext = contentParams.fileExt ? `.${contentParams.fileExt}` : path.extname(title);
                    const fileName = (title.includes('.') ? title : `${title || `file_${id}`}${ext}`)
                        .replace(/[/\\?%*:|"<>]/g, '_').replace(/[. ]+$/, '').trim() || `file_${id}${ext}`;
                    // Thư mục con theo msgId: giữ tên file gốc (người nhận thấy đúng tên) mà không đụng file trùng tên
                    const rel = await FileStorageService.downloadFile(zaloId, url, fileName, cookies, userAgent, `fw_${id}`);
                    if (rel) localPaths = { file: rel, fileName };
                }
            }

            const mainPath = localPaths.main || localPaths.file;
            if (!mainPath) return { success: false, error: 'Không tải được tệp từ Zalo (không có link hoặc link đã hết hạn)' };
            if (kind === 'image' || kind === 'gif') {
                const absPath = FileStorageService.resolveAbsolutePath(mainPath);
                const check = FileStorageService.validateImageFile(absPath);
                if (!check.valid && check.reason !== 'truncated') {
                    try { fs.unlinkSync(absPath); } catch { /* đã xoá */ }
                    return { success: false, error: `Ảnh tải về không đọc được (${check.reason})` };
                }
            }
            db.updateLocalPaths(zaloId, String(row.msg_id || msgId), localPaths);
            return { success: true, localPath: mainPath, localPaths };
        } catch (error: any) {
            Logger.warn(`[fileIpc] downloadMessageMedia ${kind} ${msgId}: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    /**
     * Kiểm tra media (video / ảnh trong album) còn trên CDN Zalo không. Hết hạn → lưu cờ media_expired.
     * Trả { expired: true } nếu đã hết hạn; { expired: false, unknown: true } nếu không xác định được (mất mạng…).
     */
    ipcMain.handle('file:checkMediaExpired', async (_event, params: {
        zaloId: string;
        msgId: string;
        urls: string[];
        force?: boolean;
    }) => {
        const { zaloId, msgId, force } = params || ({} as any);
        if (!zaloId || !msgId) return { success: false, expired: false, error: 'Missing zaloId or msgId' };
        try {
            const db = DatabaseService.getInstance();
            const wasExpired = db.isMediaExpired(zaloId, msgId);
            if (wasExpired && !force) return { success: true, expired: true };
            const url = (params.urls || []).find(u => /^https?:\/\//i.test(String(u || '')));
            if (!url) return { success: true, expired: false, unknown: true };
            const account = db.getAccounts().find(item => item.zalo_id === zaloId);
            const result = await probeMediaUrl(url, account?.cookies, account?.user_agent);
            if (result === 'expired') {
                if (!wasExpired) db.setMediaExpired(zaloId, msgId, true);
                return { success: true, expired: true };
            }
            if (result === 'ok' && wasExpired) db.setMediaExpired(zaloId, msgId, false);
            return { success: true, expired: false, unknown: result === 'unknown' };
        } catch (error: any) {
            Logger.warn(`[fileIpc] checkMediaExpired error: ${error.message}`);
            return { success: false, expired: false, error: error.message };
        }
    });

    /**
     * Ensure MP4 file is faststart (moov atom at beginning).
     * Returns { fixed: true } if file was modified, { fixed: false } if already OK or failed.
     * Dedup: concurrent calls for the same file share one Promise.
     */
    ipcMain.handle('file:ensureFaststart', async (_event, { filePath }: { filePath: string }) => {
        // Dedup: if already processing this file, wait for existing result
        const existing = pendingFaststart.get(filePath);
        if (existing) return existing;

        const promise = (async () => {
            try {
                const absPath = FileStorageService.resolveAbsolutePath(filePath);
                if (!absPath || !fs.existsSync(absPath)) {
                    return { success: false, error: 'File not found' };
                }
                const ext = path.extname(absPath).toLowerCase();
                if (ext !== '.mp4') {
                    return { success: true, fixed: false, reason: 'Not MP4' };
                }

                // Check if already faststart by scanning first 64KB for moov atom
                const stat = fs.statSync(absPath);
                const scanBuf = Buffer.alloc(Math.min(stat.size, 64 * 1024));
                const fd = fs.openSync(absPath, 'r');
                fs.readSync(fd, scanBuf, 0, scanBuf.length, 0);
                fs.closeSync(fd);

                let offset = 0;
                while (offset < scanBuf.length - 8) {
                    const boxSize = scanBuf.readUInt32BE(offset);
                    const boxType = scanBuf.toString('ascii', offset + 4, offset + 8);
                    if (boxType === 'moov') {
                        return { success: true, fixed: false, reason: 'Already faststart' };
                    }
                    if (boxSize < 8) break;
                    offset += boxSize;
                }

                // Not faststart — fix with ffmpeg
                Logger.log(`[fileIpc] ensureFaststart: fixing ${absPath}`);
                const ffmpegBin = getFfmpegBin();
                const tempPath = absPath + '.faststart.tmp.mp4';

                const { spawnSync } = require('child_process');
                const result = spawnSync(ffmpegBin, [
                    '-y', '-i', absPath,
                    '-c', 'copy',
                    '-movflags', '+faststart',
                    tempPath,
                ], { timeout: 120_000, stdio: 'pipe' });

                if (result.status === 0 && fs.existsSync(tempPath)) {
                    fs.renameSync(tempPath, absPath);
                    Logger.log(`[fileIpc] ensureFaststart: fixed ${absPath}`);
                    return { success: true, fixed: true };
                } else {
                    try { fs.unlinkSync(tempPath); } catch {}
                    return { success: false, error: `ffmpeg exit ${result.status}` };
                }
            } catch (err: any) {
                Logger.error(`[fileIpc] ensureFaststart error: ${err.message}`);
                return { success: false, error: err.message };
            }
        })();

        pendingFaststart.set(filePath, promise);
        promise.finally(() => pendingFaststart.delete(filePath));
        return promise;
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

                // I/O bất đồng bộ: chạy mỗi lần mở hội thoại — bản đồng bộ chặn main, các IPC khác (tải tin…) phải chờ
                const v = await FileStorageService.validateImageFileAsync(absPath);
                if (!v.valid) {
                    corrupted.push({ ...item, reason: v.reason || 'unknown' });
                    // Xóa file lỗi ngay
                    await fs.promises.unlink(absPath).catch(() => {});
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
     * Employee mode: ensure media file is available locally.
     * Khác với media:resolveUrl (background download), handler này CHỜ download
     * hoàn tất trước khi trả về — dùng khi user click mở video/file để có file local ngay.
     *
     * Input: { bossUrl: string, mediaType?: string }
     * Output: { success: boolean, displayUrl: string, localPath?: string, fromCache: boolean }
     */
    ipcMain.handle('file:employeeEnsureMediaLocal', async (_event, { bossUrl, mediaType }: { bossUrl: string; mediaType?: string }) => {
        try {
            const cache = MediaCacheService.getInstance();
            if (!bossUrl) return { success: true, displayUrl: '', fromCache: false };

            // Dùng resolveUrlSync — chờ download nếu cache miss
            const result = await cache.resolveUrlSync(bossUrl, (mediaType || 'image') as any);

            // Extract local path từ file:// URL
            let localPath = '';
            if (result.displayUrl.startsWith('file://')) {
                const urlPath = result.displayUrl.replace('file:///', '');
                // Handle both Unix and Windows paths
                localPath = decodeURIComponent(urlPath);
                // Normalize Windows paths
                if (process.platform === 'win32' && localPath.startsWith('/')) {
                    localPath = localPath.replace(/^\//, '');
                }
                // Kiểm tra file thực sự tồn tại
                try {
                    if (!require('fs').existsSync(localPath)) {
                        localPath = '';
                    }
                } catch { localPath = ''; }
            }
            // Ưu tiên bản sao đúng tên + đuôi trong thư mục media: file cache hash không có đuôi → openPath không chọn
            // được app. (File Boss giờ cần token nên không mở URL Boss bằng trình duyệt ngoài được nữa.)
            const namedCopy = cache.getLocalCopyPath(bossUrl);
            if (namedCopy) localPath = namedCopy;

            return {
                success: true,
                displayUrl: result.displayUrl,
                localPath,
                fromCache: result.fromCache,
            };
        } catch (err: any) {
            Logger.error(`[fileIpc] employeeEnsureMediaLocal error: ${err.message}`);
            return { success: false, displayUrl: bossUrl, localPath: '', fromCache: false, error: err.message };
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
