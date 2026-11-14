import { ipcMain, dialog, shell, app, net } from 'electron';
import FileStorageService from '../../../src/services/file/FileStorageService';
import DatabaseService from '../../../src/services/database/DatabaseService';
import EventBroadcaster from '../../../src/services/event/EventBroadcaster';
import MediaCacheService from '../../../src/services/cache/MediaCacheService';
import { bossAuthHeaders } from '../../../src/services/http/bossSessionAuth';
import { decodeUrlPath } from '../../../src/services/http/bossFileAccess';
import { classifyMediaError, probeMediaUrl } from '../../../src/services/file/MediaExpiryService';
import { isZaloMediaUrl, toZaloJpgUrl } from '../../../src/utils/zalo/zaloImageUrl';
import {
    ensureMessageImage, repairMessageImage, type ImageEnsureDeps, type ImageEnsureResult, type ImageRepairDeps,
} from '../../../src/services/file/imageRepair';
import Logger from '../../../src/utils/Logger';
import * as fs from 'fs';
import * as path from 'path';
import { tr } from '../../../src/shared/i18n';

/** Faststart repair queue: dedup concurrent ensureFaststart calls for the same file */
const pendingFaststart = new Map<string, Promise<{ success: boolean; fixed?: boolean; reason?: string; error?: string }>>();

/** Get the ffmpeg path: prefer ffmpeg-static, fall back to PATH */
function getFfmpegBin(): string {
    try {
        // ffmpeg-static returns the path to the binary
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

/** Boss file URL for the Boss file path stored in the message (same as toLocalMediaUrl in the UI). */
function bossFileUrl(bossUrl: string, localPath: string, fallbackName: string): string {
    const base = bossUrl.replace(/\/+$/, '');
    const normalized = localPath.replace(/\\/g, '/');
    const mediaMatch = normalized.match(/(?:^|\/)(media|_uploads|avatar)\/(.+)/);
    // Encode each segment: file names with "#", "%"… (Boss decodes once)
    if (mediaMatch) return `${base}/api/${mediaMatch[1]}/${mediaMatch[2].split('/').map(encodeURIComponent).join('/')}`;
    return `${base}/api/media/external/${encodeURIComponent(normalized || fallbackName)}`;
}

/**
 * Employee machine: the message's file is on the Boss machine (local_paths holds Boss's path) → use the copy Boss saved: the copy already
 * downloaded to this machine earlier (opening the file / viewing the image); if there is none, download it from Boss with the employee session token.
 * 'unavailable' = not an employee workspace.
 */
async function saveFromBoss(localPath: string, destPath: string, fallbackName: string): Promise<'saved' | 'failed' | 'unavailable'> {
    const { default: WorkspaceManager } = require('../../../src/utils/app/WorkspaceManager');
    const ws = WorkspaceManager.getInstance().getActiveWorkspace();
    if (ws?.type !== 'remote' || !ws.bossUrl || !ws.token) return 'unavailable';
    const url = bossFileUrl(ws.bossUrl, localPath, fallbackName);
    try {
        const cached = MediaCacheService.getInstance().getLocalCopyPath(url);
        if (cached) {
            fs.copyFileSync(cached, destPath);
            return 'saved';
        }
    } catch { /* re-download from Boss */ }
    try {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${ws.token}` },
            signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
        return 'saved';
    } catch (e: any) {
        Logger.warn(`[fileIpc] saveAs from Boss failed: ${e.message}`);
        return 'failed';
    }
}

/**
 * Download the original file link (Zalo CDN / Facebook CDN / Boss URL) directly to the location the user picks. Before, it required a zaloId (which no
 * caller passed) → every file not yet on the machine reported "zaloId required for remote download".
 */
async function downloadUrlTo(url: string, destPath: string, opts: { image: boolean; cookiesJson?: string; userAgent?: string }): Promise<void> {
    const source = opts.image ? toZaloJpgUrl(url) : url;
    const headers: Record<string, string> = {
        'User-Agent': opts.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://chat.zalo.me/',
        ...bossAuthHeaders(source),
    };
    if (opts.cookiesJson) {
        const cookieHeader = FileStorageService.buildCookieHeader(opts.cookiesJson);
        if (cookieHeader) headers['Cookie'] = cookieHeader;
    }
    const response = await net.fetch(source, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error(tr('File rỗng'));
    fs.writeFileSync(destPath, buffer);
}

/** Real dependencies (DB, disk, CDN) of imageRepair for file:repairImage / file:ensureMessageImage. */
function imageRepairDeps(threadIdHint: string | undefined, emitLocalPath: ImageRepairDeps['emitLocalPath']): ImageEnsureDeps {
    const db = DatabaseService.getInstance();
    return {
        isMediaExpired: (zaloId, msgId) => db.isMediaExpired(zaloId, msgId),
        setMediaExpired: (zaloId, msgId, expired) => db.setMediaExpired(zaloId, msgId, expired),
        messageInfo: (zaloId, msgId) => {
            const info = { localPath: '', threadId: '', imageUrl: '', msgType: '', channel: '' };
            try {
                const row: any = db.getMessageById(zaloId, msgId, threadIdHint || undefined);
                if (!row) return info;
                info.threadId = String(row.thread_id || '');
                info.msgType = String(row.msg_type || '');
                info.channel = String(row.channel || '');
                try {
                    const lp = typeof row.local_paths === 'string' ? JSON.parse(row.local_paths || '{}') : (row.local_paths || {});
                    info.localPath = String(lp?.main || lp?.hd || '');
                } catch { /* broken local_paths */ }
                try {
                    const contentRaw = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
                    info.imageUrl = DatabaseService.extractImageUrlFromContent(contentRaw) || '';
                } catch { /* content is not JSON */ }
            } catch (e: any) {
                Logger.warn(`[fileIpc] repairImage: DB lookup failed: ${e.message}`);
            }
            return info;
        },
        account: (zaloId) => db.getAccounts().find(item => item.zalo_id === zaloId),
        download: (zaloId, url, cookies, userAgent) => FileStorageService.downloadImage(zaloId, url, undefined, cookies, userAgent),
        toJpgUrl: toZaloJpgUrl,
        resolveAbsolutePath: (relOrAbs) => FileStorageService.resolveAbsolutePath(relOrAbs),
        validateImage: (absPath) => FileStorageService.validateImageFile(absPath),
        mediaBaseDir: () => FileStorageService.getBaseDir(),
        saveLocalPath: (zaloId, msgId, relPath) => db.updateLocalPaths(zaloId, msgId, { main: relPath }),
        emitLocalPath,
        classifyError: classifyMediaError,
        probe: probeMediaUrl,
        exists: (absPath) => fs.existsSync(absPath),
        unlink: (absPath) => fs.unlinkSync(absPath),
        log: (message) => Logger.log(message),
        warn: (message) => Logger.warn(message),
        isZaloMediaUrl,
        // File moved to Cloudflare R2 (media saved to the cloud) → fetch it back to its old place; R2 off / not loaded → false
        restoreFromCloud: async (absPath) => {
            try {
                return !!(await require('../../../src/services/cloudflare/media').cloudMedia.resolveMissingMediaFile(absPath));
            } catch {
                return false;
            }
        },
    };
}

/** The UI has an employee (remote) workspace open and the command is not from Boss running on the employee's behalf (`_fromRelay`). */
function imageRunsOnBoss(params: any): boolean {
    if (params?._fromRelay) return false;
    try {
        const { default: WorkspaceManager } = require('../../../src/utils/app/WorkspaceManager');
        return WorkspaceManager.getInstance().getActiveWorkspace()?.type === 'remote';
    } catch {
        return false;
    }
}

/** Message id only: Boss looks up the image link + path in its own DB (does not accept a link / path from the employee machine). */
function ensureImageParams(params: any): { zaloId: string; msgId: string; threadId?: string; force: boolean } {
    return {
        zaloId: String(params?.zaloId || ''),
        msgId: String(params?.msgId || ''),
        threadId: params?.threadId ? String(params.threadId) : undefined,
        force: !!params?.force,
    };
}

/** Downloading an image can take up to 30 s (CDN) + fetching it back from R2 */
const ENSURE_IMAGE_TIMEOUT_MS = 90_000;

/** Employee machine: asks Boss to get the message's image (downloaded with the account session on Boss); the result is the path on the Boss machine. */
async function ensureImageOnBoss(params: any): Promise<ImageEnsureResult> {
    const { proxyToBossWithResult } = require('../network/proxyHelper');
    return proxyToBossWithResult('file:ensureMessageImage', ensureImageParams(params), { timeoutMs: ENSURE_IMAGE_TIMEOUT_MS });
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
            if (!resolved || !fs.existsSync(resolved)) return { success: false, error: tr('Không tìm thấy file trên máy'), notFound: true };
            // shell.openPath does not throw: it returns an error string (no app can open it…). Before, this was ignored and the UI thought it had opened
            const openError = await shell.openPath(resolved);
            if (openError) return { success: false, error: openError };
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    /** Open the folder containing the file and highlight it (Explorer/Finder) */
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
     * Save a file to the machine: shows a location picker, copies the local file or downloads from the URL
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
                filters.push({ name: tr('Hình ảnh'), extensions: imageExts });
            } else if (videoExts.includes(extNoDot)) {
                filters.push({ name: 'Video', extensions: videoExts });
            }
            filters.push({ name: tr('Tất cả file'), extensions: ['*'] });

            const result = await dialog.showSaveDialog({
                defaultPath: params.defaultName,
                filters,
                title: tr('Lưu file về máy'),
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
                    // Non-image: only check size > 0
                    try { localValid = fs.statSync(resolvedLocalPath).size > 0; } catch {}
                }
            }

            if (localValid && resolvedLocalPath) {
                fs.copyFileSync(resolvedLocalPath, destPath);
            } else {
                // Employee machine: get Boss's saved copy first (the message's exact file), otherwise the original link
                const fromBoss = params.localPath ? await saveFromBoss(params.localPath, destPath, params.defaultName) : 'unavailable';
                if (fromBoss !== 'saved') {
                    if (params.remoteUrl) {
                        try {
                            await downloadUrlTo(params.remoteUrl, destPath, {
                                image: isImageExt, cookiesJson: params.cookiesJson, userAgent: params.userAgent,
                            });
                        } catch (e: any) {
                            Logger.error(`[fileIpc] saveAs download error: ${e.message}`);
                            return { success: false, error: tr('Không tải được file ({{message}}). Link gốc có thể đã hết hạn.', { message: e.message }) };
                        }
                    } else if (fromBoss === 'failed') {
                        return { success: false, error: tr('Không tải được file từ máy Boss. Kiểm tra kết nối tới Boss rồi thử lại.') };
                    } else {
                        return { success: false, error: tr('Không có nguồn file để lưu') };
                    }
                }
            }

            return { success: true, savedPath: destPath };
        } catch (error: any) {
            Logger.error(`[fileIpc] saveAs error: ${error.message}`);
            return { success: false, error: error.message };
        }
    });

    /** Save base64 data as a temp file to send a clipboard image */
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
     * Read an image from a local path or remote URL and return it as base64.
     * Uses the main process to avoid CORS when fetching a remote URL from the renderer.
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
                    // Boss file URLs (employees) need the session token; other URLs (CDN) get nothing attached
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
     * Get video metadata (duration, width, height) and extract a thumbnail using ffmpeg-static.
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

            // ── Probe metadata with ffmpeg -i (stderr) ──────────────────
            try {
                // ffmpeg -i prints the info to stderr, no output file needed
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

            // Try seeking to 10% of the duration (at least 1s, at most 5s), fall back to 0s
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
     * Repair a broken image: re-download it from the CDN (the account's session); if the file is readable, update the DB + notify the UI, then remove the old file.
     * The renderer calls this on img onError (MediaBubble / MediaViewer) and when a broken image is found while scanning a conversation on open.
     * Employee machine: the message's image is on the Boss machine (local_paths holds Boss's path) → Boss checks its own copy; if it is missing /
     * broken, Boss re-downloads it (file:ensureMessageImage); the result is the path on the Boss machine. Before, it downloaded to the employee machine
     * and wrote that path into the message: Boss did not have the file → image broken → downloaded again → the image kept flickering.
     */
    ipcMain.handle('file:repairImage', async (_event, params: {
        zaloId: string;
        msgId: string;
        threadId?: string;
        localPath?: string;
        remoteUrl?: string;
        /** true = ignore the "đã hết hạn" (expired) flag (the user clicked "Thử tải lại" (Retry download)) */
        force?: boolean;
        _fromRelay?: boolean;
    }) => {
        if (imageRunsOnBoss(params)) return ensureImageOnBoss(params);
        // One pass per message. The old file is removed only after the new download finishes, and only files in the media folder are deleted (imageRepair.ts)
        return repairMessageImage(params, imageRepairDeps(params?.threadId, (zaloId, msgId, threadId, relPath) =>
            EventBroadcaster.sendDirect('event:localPath', { zaloId, msgId, threadId, localPaths: { main: relPath } })));
    });

    /**
     * A Zalo message's image must exist on the Boss machine: if it is there → return the path; if not (history-synced message, Boss was off when it arrived,
     * download failed) → download it with the account session (imageRepair.ensureMessageImage). The UI calls this when an image only shows the Zalo link
     * (lib/media/ensureMessageImage). Employee machines hand this over to Boss (proxy: chat permission + assigned account); Boss reports
     * event:localPath to the Boss UI and to the employee assigned the account.
     */
    ipcMain.handle('file:ensureMessageImage', async (_event, params: {
        zaloId: string;
        msgId: string;
        threadId?: string;
        force?: boolean;
        _fromRelay?: boolean;
    }) => {
        if (imageRunsOnBoss(params)) return ensureImageOnBoss(params);
        const clean = ensureImageParams(params);
        return ensureMessageImage(clean, imageRepairDeps(clean.threadId, (zaloId, msgId, threadId, relPath) =>
            EventBroadcaster.emit('event:localPath', { zaloId, msgId, threadId, localPaths: { main: relPath } })));
    });

    /**
     * Download the media of 1 Zalo message to the machine. Used when forwarding a message that has not been downloaded: zca-js only resends images / GIFs / files from a
     * local file, and messages synced from the phone / old messages do not download their media by themselves. The file name + local_paths key are the same as when
     * the message is received (EventBroadcaster) → the bubble shows "đã có trên máy" (already on the machine); next time it is reused without downloading again.
     */
    ipcMain.handle('file:downloadMessageMedia', async (_event, params: {
        zaloId: string;
        msgId: string;
        threadId?: string;
        kind: 'image' | 'gif' | 'file' | 'voice' | 'video';
    }) => {
        const { zaloId, msgId, threadId, kind } = params || ({} as any);
        if (!zaloId || !msgId || !kind) return { success: false, error: tr('Thiếu thông tin tin nhắn') };
        const isHttp = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//i.test(value);
        const parseObject = (value: unknown): any => {
            if (value && typeof value === 'object') return value;
            if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return null;
            try { return JSON.parse(value); } catch { return null; }
        };
        try {
            const db = DatabaseService.getInstance();
            const row: any = db.getMessageById(zaloId, String(msgId), threadId);
            if (!row) return { success: false, error: tr('Không tìm thấy tin nhắn') };
            const content = parseObject(row.content);
            const contentParams = parseObject(content?.params) || {};
            // Old-format messages keep the link in the attachments column
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
                // The fallback link in attachments is only used for images / files: other old message types keep the icon / link of the message there
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
                    // Subfolder per msgId: keeps the original file name (the recipient sees the right name) without touching files with the same name
                    const rel = await FileStorageService.downloadFile(zaloId, url, fileName, cookies, userAgent, `fw_${id}`);
                    if (rel) localPaths = { file: rel, fileName };
                }
            }

            const mainPath = localPaths.main || localPaths.file;
            if (!mainPath) return { success: false, error: tr('Không tải được tệp từ Zalo (không có link hoặc link đã hết hạn)') };
            if (kind === 'image' || kind === 'gif') {
                const absPath = FileStorageService.resolveAbsolutePath(mainPath);
                const check = FileStorageService.validateImageFile(absPath);
                if (!check.valid && check.reason !== 'truncated') {
                    try { fs.unlinkSync(absPath); } catch { /* deleted */ }
                    return { success: false, error: tr('Ảnh tải về không đọc được ({{reason}})', { reason: check.reason }) };
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
     * Check whether the media (video / image in an album) is still on the Zalo CDN. Expired → save the media_expired flag.
     * Returns { expired: true } if it has expired; { expired: false, unknown: true } if it cannot be determined (no network…).
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
     * Batch validate local images: checks several images at once and returns the list of broken ones.
     * The renderer calls this when messages load to find and repair images broken earlier.
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
                if (!imageExts.includes(ext)) continue; // Validate images only

                // Async I/O: runs each time a conversation is opened. A sync version would block main, and other IPCs (loading messages…) would have to wait
                const v = await FileStorageService.validateImageFileAsync(absPath);
                // A JPEG missing its end marker can still be displayed (repairImage also lets it through). Before, it was deleted and downloaded again
                // each time a conversation is opened. Do not delete the file here: repairImage removes the old file only after the new one is downloaded (if the download fails, then
                // the old file stays and does not turn into a broken image everywhere).
                if (!v.valid && v.reason !== 'truncated') corrupted.push({ ...item, reason: v.reason || 'unknown' });
            } catch {}
        }

        return { success: true, corrupted };
    });

    /**
     * MediaCache: resolve URL cache-first
     * Employee: check the local cache first; on a miss, download in the background + return the Boss URL
     */
    ipcMain.handle('media:resolveUrl', async (_event, { bossUrl, mediaType }: { bossUrl: string; mediaType?: string }) => {
        try {
            const cache = MediaCacheService.getInstance();
            if (!bossUrl) return { success: true, displayUrl: '', fromCache: false };

            // 1. Check MediaCacheService first
            const cached = cache.hasCache(bossUrl);
            if (cached) {
                const result = await cache.resolveUrl(bossUrl, (mediaType || 'image') as any);
                return { success: true, displayUrl: result.displayUrl, fromCache: true };
            }

            // 2. Check the workspace media directory (file already downloaded earlier)
            //    Boss URL pattern: /api/media/{path} → maps to workspace media/
            try {
                const mediaPath = bossUrl.includes('/api/media/')
                    ? 'media/' + decodeUrlPath(bossUrl.split('/api/media/')[1].split(/[?#]/)[0])
                    : '';
                if (mediaPath) {
                    const absPath = FileStorageService.resolveAbsolutePath(mediaPath);
                    if (absPath && fs.existsSync(absPath)) {
                        // File exists in the workspace → use the file:// URL
                        const normalized = absPath.replace(/\\/g, '/');
                        const fileUrl = `file:///${normalized.startsWith('/') ? '' : '/'}${normalized}`;
                        Logger.log(`[fileIpc] media:resolveUrl → workspace hit: ${mediaPath}`);
                        return { success: true, displayUrl: fileUrl, fromCache: true };
                    }
                }
            } catch {}

            // 3. Cache miss → download in the background from Boss
            const result = await cache.resolveUrl(bossUrl, (mediaType || 'image') as any);
            return { success: true, displayUrl: result.displayUrl, fromCache: result.fromCache };
        } catch (err: any) {
            Logger.error(`[fileIpc] media:resolveUrl error: ${err.message}`);
            return { success: false, displayUrl: bossUrl, fromCache: false };
        }
    });

    /** Check whether the URL is already cached or in the workspace media (sync, fast) */
    ipcMain.handle('media:hasCache', async (_event, { bossUrl }: { bossUrl: string }) => {
        try {
            const cache = MediaCacheService.getInstance();
            if (cache.hasCache(bossUrl)) return { success: true, cached: true };
            // Check workspace media directory
            const mediaPath = bossUrl.includes('/api/media/')
                ? 'media/' + decodeUrlPath(bossUrl.split('/api/media/')[1].split(/[?#]/)[0])
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
     * Employee mode: ensure the media file is available locally.
     * Unlike media:resolveUrl (background download), this handler WAITS for the download
     * to finish before it returns - used when the user clicks to open a video/file so the local file is ready at once.
     *
     * Input: { bossUrl: string, mediaType?: string }
     * Output: { success: boolean, displayUrl: string, localPath?: string, fromCache: boolean }
     */
    ipcMain.handle('file:employeeEnsureMediaLocal', async (_event, { bossUrl, mediaType }: { bossUrl: string; mediaType?: string }) => {
        try {
            const cache = MediaCacheService.getInstance();
            if (!bossUrl) return { success: true, displayUrl: '', fromCache: false };

            // Use resolveUrlSync: waits for the download if the cache misses
            const result = await cache.resolveUrlSync(bossUrl, (mediaType || 'image') as any);

            // Extract the local path from the file:// URL
            let localPath = '';
            if (result.displayUrl.startsWith('file://')) {
                const urlPath = result.displayUrl.replace('file:///', '');
                // Handle both Unix and Windows paths
                localPath = decodeURIComponent(urlPath);
                // Normalize Windows paths
                if (process.platform === 'win32' && localPath.startsWith('/')) {
                    localPath = localPath.replace(/^\//, '');
                }
                // Check the file really exists
                try {
                    if (!require('fs').existsSync(localPath)) {
                        localPath = '';
                    }
                } catch { localPath = ''; }
            }
            // Prefer the copy with the right name + extension in the media folder: a cache file's hash has no extension, so openPath cannot choose the right app
            // for it. (Boss files now need a token, so a Boss URL can no longer be opened in an external browser.)
            const namedCopy = cache.getLocalCopyPath(bossUrl) || cache.ensureLocalCopy(bossUrl, localPath);
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
     * Batch preload: takes a list of Boss URLs and triggers background downloads
     * Returns at once, without waiting for the downloads to finish
     */
    ipcMain.handle('media:preloadBatch', async (_event, { urls }: { urls: string[] }) => {
        try {
            const cache = MediaCacheService.getInstance();
            let triggered = 0;
            for (const url of urls) {
                if (!url) continue;
                // Skip if it is already in the cache or the workspace media
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
