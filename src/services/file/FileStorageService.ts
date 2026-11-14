import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { app } from 'electron';
import Logger from '../../utils/Logger';
import { toZaloJpgUrl } from '../../utils/zalo/zaloImageUrl';
import { bossAuthHeaders } from '../http/bossSessionAuth';
import { toSafeFileName } from './safeFileName';
import { writeMediaFile } from './writeMediaFile';
import { getUiRemoteWorkspace, inUiRemoteScope } from '../database/dbScope';

class FileStorageService {
    private static baseDir: string = '';
    /** Media folder of the remote workspace that has been created (not checked again on each call). */
    private static ensuredRemoteDirs = new Set<string>();

    /**
     * Resolve the root media folder based on the current workspace.
     * - Default workspace: dbFolder/media/
     * - Additional workspaces: dbFolder/workspace-{id}/media/
     * The first call reads the config, then caches it in a static field.
     *
     * By execution flow (dbScope): commands from the UI showing a remote workspace → that workspace's media; everything else (Zalo,
     * Telegram, Facebook… running in the background) → the media of the local workspace that is running, whichever workspace the UI is showing.
     */
    public static getBaseDir(): string {
        if (inUiRemoteScope()) {
            const remoteDir = getUiRemoteWorkspace()?.mediaDir;
            if (remoteDir) {
                if (!this.ensuredRemoteDirs.has(remoteDir)) {
                    if (!fs.existsSync(remoteDir)) fs.mkdirSync(remoteDir, { recursive: true });
                    this.ensuredRemoteDirs.add(remoteDir);
                }
                return remoteDir;
            }
        }
        if (!this.baseDir) {
            // Try workspace-aware resolution first
            try {
                const WorkspaceManager = require('../../utils/app/WorkspaceManager').default;
                const wm = WorkspaceManager.getInstance();
                this.baseDir = wm.resolveMediaPath(wm.getRuntimeWorkspace());
            } catch {
                // Fallback: legacy resolution
                const userDataPath = app.getPath('userData');
                let mediaRoot = userDataPath;

                const configPath = path.join(userDataPath, 'deplao-config.json');
                if (fs.existsSync(configPath)) {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        if (cfg.dbFolder && fs.existsSync(cfg.dbFolder)) {
                            mediaRoot = cfg.dbFolder;
                        }
                    } catch {}
                }

                this.baseDir = path.join(mediaRoot, 'media');
            }

            if (!fs.existsSync(this.baseDir)) {
                fs.mkdirSync(this.baseDir, { recursive: true });
            }
            Logger.log(`[FileStorageService] Media base dir: ${this.baseDir}`);
        }
        return this.baseDir;
    }

    /**
     * Reset the cache when the user changes the storage path (called after saving the new config).
     */
    public static resetBaseDir(): void {
        this.baseDir = '';
        Logger.log('[FileStorageService] Base dir cache cleared, will re-resolve on next access');
    }

    /**
     * Store media to R2 (Cloudflare): reports the file that was just written for backup (it is only queued; sync off → does nothing).
     * Lazy require: does not pull the Cloudflare module in when this file loads; errors never affect saving the file.
     */
    private static noteCloudMediaWrite(absPath: string): void {
        try {
            require('../cloudflare/media').cloudMedia.noteFileWritten(absPath);
        } catch { /* R2 feature not ready yet → skip */ }
    }

    /**
     * Convert an absolute path to a path relative to the config folder (parent of media/).
     * Returns "media/zaloId/date/img.jpg" - folder-agnostic: only the part after the
     * configured storage root is kept, so moving the folder never breaks local_paths.
     * If the path is not under the config folder, returns it as-is (safety fallback).
     */
    public static toRelativePath(absPath: string): string {
        if (!absPath) return absPath;
        const mediaDir = this.getBaseDir().replace(/\\/g, '/').replace(/\/$/, '');
        // configFolder = parent of media dir (e.g. "D:/Du-lieu-zalo-dep-lao")
        const configDir = mediaDir.substring(0, mediaDir.lastIndexOf('/'));
        const base = configDir + '/';
        const normalized = absPath.replace(/\\/g, '/');
        if (normalized.startsWith(base)) {
            return normalized.slice(base.length); // → "media/zaloId/date/img.jpg"
        }
        // Not under configFolder → return as-is (already relative or different root)
        return absPath;
    }

    /**
     * Resolve a relative path (stored as "media/zaloId/date/img.jpg") to an absolute path.
     * For absolute paths that no longer exist (old drive after folder move), automatically
     * remaps to the current configFolder by extracting the "media/..." suffix.
     */
    public static resolveAbsolutePath(relOrAbsPath: string): string {
        if (!relOrAbsPath) return '';
        if (!path.isAbsolute(relOrAbsPath)) {
            // Relative: "media/zaloId/date/img.jpg" → configFolder/media/zaloId/...
            const configFolder = path.dirname(this.getBaseDir());
            return path.join(configFolder, relOrAbsPath);
        }
        // Absolute path - serve as-is if it exists
        if (fs.existsSync(relOrAbsPath)) return relOrAbsPath;
        // File not found (old drive/folder after move) - remap via /media/ marker
        const normalized = relOrAbsPath.replace(/\\/g, '/');
        const mediaIdx = normalized.lastIndexOf('/media/');
        if (mediaIdx >= 0) {
            const configFolder = path.dirname(this.getBaseDir());
            const relativePart = normalized.slice(mediaIdx + 1); // "media/zaloId/..."
            const remapped = path.join(configFolder, relativePart);
            if (fs.existsSync(remapped)) return remapped;
        }
        return relOrAbsPath; // fallback: return original
    }

    /**
     * Check the validity of an image file on disk.
     * Reads ~20 bytes at the start and end of the file: very fast, does not decode the image.
     * @returns `{ valid: true }` if the file is valid, `{ valid: false, reason }` if there is an error.
     */
    public static validateImageFile(filePath: string): { valid: boolean; reason?: string } {
        try {
            if (!fs.existsSync(filePath)) return { valid: false, reason: 'not_found' };

            const stat = fs.statSync(filePath);
            if (stat.size === 0) return { valid: false, reason: 'empty' };

            // First 12 bytes (magic bytes) + last 12 bytes (end marker), one file open
            const headBuf = Buffer.alloc(12);
            const tailBuf = Buffer.alloc(12);
            const fd = fs.openSync(filePath, 'r');
            let bytesRead = 0;
            let tailBytesRead = 0;
            try {
                bytesRead = fs.readSync(fd, headBuf, 0, 12, 0);
                tailBytesRead = fs.readSync(fd, tailBuf, 0, 12, Math.max(0, stat.size - 12));
            } finally {
                fs.closeSync(fd);
            }
            return this.checkImageBytes(filePath, stat.size, headBuf, bytesRead, tailBuf, tailBytesRead);
        } catch {
            // If the file cannot be read → treat it as invalid
            return { valid: false, reason: 'read_error' };
        }
    }

    /**
     * validateImageFile with async I/O: bulk checks (file:validateLocalImages when opening a conversation) do not block
     * main. The sync version opens and reads each file on the main thread, so every other IPC (including loading messages) has to wait.
     */
    public static async validateImageFileAsync(filePath: string): Promise<{ valid: boolean; reason?: string }> {
        let handle: fs.promises.FileHandle;
        try {
            handle = await fs.promises.open(filePath, 'r');
        } catch (err: any) {
            return { valid: false, reason: err?.code === 'ENOENT' ? 'not_found' : 'read_error' };
        }
        try {
            const { size } = await handle.stat();
            if (size === 0) return { valid: false, reason: 'empty' };
            const headBuf = Buffer.alloc(12);
            const tailBuf = Buffer.alloc(12);
            const { bytesRead } = await handle.read(headBuf, 0, 12, 0);
            const { bytesRead: tailBytesRead } = await handle.read(tailBuf, 0, 12, Math.max(0, size - 12));
            return this.checkImageBytes(filePath, size, headBuf, bytesRead, tailBuf, tailBytesRead);
        } catch {
            return { valid: false, reason: 'read_error' };
        } finally {
            await handle.close().catch(() => {});
        }
    }

    /** The content-check part of validateImageFile / validateImageFileAsync (the first 12 bytes + last 12 bytes have already been read). */
    private static checkImageBytes(
        filePath: string, size: number, headBuf: Buffer, bytesRead: number, tailBuf: Buffer, tailBytesRead: number,
    ): { valid: boolean; reason?: string } {
        if (bytesRead < 2) return { valid: false, reason: 'not_image_content' };

        // Detect an HTML error page (the CDN returns 200 but the content is HTML)
        const headStr = headBuf.slice(0, Math.min(bytesRead, 6)).toString('ascii').toLowerCase();
        if (headStr.startsWith('<html') || headStr.startsWith('<!doc')) {
            return { valid: false, reason: 'not_image_content' };
        }

        // Check the magic bytes for the common image formats
        const isJpeg = headBuf[0] === 0xFF && headBuf[1] === 0xD8 && headBuf[2] === 0xFF;
        const isPng = headBuf[0] === 0x89 && headBuf[1] === 0x50 && headBuf[2] === 0x4E && headBuf[3] === 0x47;
        const isGif = headBuf.slice(0, 6).toString('ascii') === 'GIF87a'
                   || headBuf.slice(0, 6).toString('ascii') === 'GIF89a';
        const isWebP = headBuf.slice(0, 4).toString('ascii') === 'RIFF'
                    && headBuf.slice(8, 12).toString('ascii') === 'WEBP';
        const isBmp = headBuf[0] === 0x42 && headBuf[1] === 0x4D;
        const isTiff = (headBuf[0] === 0x49 && headBuf[1] === 0x49 && headBuf[2] === 0x2A && headBuf[3] === 0x00)
                    || (headBuf[0] === 0x4D && headBuf[1] === 0x4D && headBuf[2] === 0x00 && headBuf[3] === 0x2A);
        // SVG is text, so it has no binary magic bytes. SVG media is
        // common in Zalo attachments and must not be deleted as corrupt.
        const isSvg = path.extname(filePath).toLowerCase() === '.svg'
                    && headBuf.slice(0, bytesRead).toString('utf8').toLowerCase().includes('<svg');
        // AVIF/HEIF: ftyp box at offset 4
        const isAvif = bytesRead >= 8
                    && headBuf[4] === 0x66 && headBuf[5] === 0x74
                    && headBuf[6] === 0x79 && headBuf[7] === 0x70;

        if (!isJpeg && !isPng && !isGif && !isWebP && !isBmp && !isTiff && !isAvif && !isSvg) {
            return { valid: false, reason: 'not_image_content' };
        }

        // Tier 3: check the end marker (catches truncated files)
        if (size >= 2) {
            if (isJpeg) {
                // A JPEG must end with FF D9
                if (tailBytesRead >= 2) {
                    const last = tailBuf[tailBytesRead - 2];
                    const last2 = tailBuf[tailBytesRead - 1];
                    if (last !== 0xFF || last2 !== 0xD9) {
                        return { valid: false, reason: 'truncated' };
                    }
                }
            } else if (isPng) {
                // A PNG must have an IEND chunk at the very end
                // Structure of the last 12 bytes: [len:4][type:4][crc:4]
                //   len=0x00000000, type="IEND", crc=CRC32("IEND")
                // Need to check the last 8 bytes: type ("IEND") + CRC
                if (tailBytesRead >= 8) {
                    const iendSig = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
                    const tailSlice = tailBuf.slice(tailBytesRead - 8);
                    if (!tailSlice.equals(iendSig)) {
                        return { valid: false, reason: 'truncated' };
                    }
                }
            }
        }

        return { valid: true };
    }

    /**
     * Get the media folder path for one account
     */
    public static getAccountDir(zaloId: string): string {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const dir = path.join(this.getBaseDir(), zaloId, today);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    public static getTaskAttachmentDir(taskId: string): string {
        const dir = path.join(this.getBaseDir(), 'erp', 'tasks', taskId);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }

    public static saveTaskAttachment(taskId: string, sourcePath: string, preferredName?: string): { filePath: string; fileName: string; size: number } {
        if (!sourcePath) return { filePath: '', fileName: preferredName || '', size: 0 };

        const resolvedSource = this.resolveAbsolutePath(sourcePath);
        if (!resolvedSource || !fs.existsSync(resolvedSource)) {
            return {
                filePath: sourcePath,
                fileName: preferredName || path.basename(sourcePath),
                size: 0,
            };
        }

        const relativeExisting = this.toRelativePath(resolvedSource);
        if (relativeExisting !== resolvedSource) {
            const stat = fs.statSync(resolvedSource);
            return {
                filePath: relativeExisting,
                fileName: preferredName || path.basename(resolvedSource),
                size: stat.size,
            };
        }

        const targetDir = this.getTaskAttachmentDir(taskId);
        const parsed = path.parse(preferredName || path.basename(resolvedSource));
        const safeBaseName = (parsed.name || 'attachment').replace(/[/\\?%*:|"<>]/g, '_');
        const ext = parsed.ext || path.extname(resolvedSource) || '.bin';

        let candidateName = `${safeBaseName}${ext}`;
        let candidatePath = path.join(targetDir, candidateName);
        let index = 1;
        while (fs.existsSync(candidatePath) && path.resolve(candidatePath) !== path.resolve(resolvedSource)) {
            candidateName = `${safeBaseName}-${index}${ext}`;
            candidatePath = path.join(targetDir, candidateName);
            index += 1;
        }

        if (path.resolve(candidatePath) !== path.resolve(resolvedSource)) {
            fs.copyFileSync(resolvedSource, candidatePath);
            this.noteCloudMediaWrite(candidatePath);
        }

        const stat = fs.statSync(candidatePath);
        return {
            filePath: this.toRelativePath(candidatePath),
            fileName: candidateName,
            size: stat.size,
        };
    }

    public static deleteManagedTaskAttachment(relOrAbsPath: string): void {
        if (!relOrAbsPath) return;
        const absolutePath = this.resolveAbsolutePath(relOrAbsPath);
        const mediaDir = this.getBaseDir();
        if (!absolutePath || !fs.existsSync(absolutePath)) return;
        if (!path.resolve(absolutePath).startsWith(path.resolve(mediaDir))) return;
        this.deleteFile(absolutePath);
    }

    /**
     * Download and save an attachment with the correct file name (no img_ prefix)
     * @param cookiesJson - cookies JSON string from auth (tough-cookie SerializedCookieJar)
     * @param userAgent   - the account's User-Agent string
     * @param subDir      - a dedicated subfolder (e.g. by msgId): keeps the original file name without picking up a file with the same name from another message
     */
    public static async downloadFile(
        zaloId: string,
        url: string,
        filename: string,
        cookiesJson?: string,
        userAgent?: string,
        subDir?: string,
    ): Promise<string> {
        try {
            const accountDir = this.getAccountDir(zaloId);
            const dir = subDir ? path.join(accountDir, subDir.replace(/[^\w.-]/g, '_')) : accountDir;
            if (subDir) await fs.promises.mkdir(dir, { recursive: true });
            // Sanitize filename: remove illegal chars, trailing dots/spaces (Windows rejects "file.")
            const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '_').replace(/[. ]+$/, '').trim() || `file_${Date.now()}`;
            const localPath = path.join(dir, safeFilename);

            // Async I/O (a busy disk does not block main): see writeMediaFile
            const existing = await fs.promises.stat(localPath).catch(() => null);
            if (existing) {
                if (existing.size > 0) return this.toRelativePath(localPath);
                Logger.warn(`[FileStorageService] Corrupted file (empty): ${safeFilename}, will re-download`);
                await fs.promises.unlink(localPath).catch(() => {});
                // Fall through to download
            }

            const headers: Record<string, string> = {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                // Facebook CDN can require facebook.com Referer (403 without it)
                'Referer': cookiesJson ? 'https://www.facebook.com/' : 'https://chat.zalo.me/',
                // Boss's files (the employee machine) need the employee session token; other URLs get nothing attached
                ...bossAuthHeaders(url),
            };
            if (cookiesJson) {
                const cookieHeader = this.buildCookieHeader(cookiesJson);
                if (cookieHeader) headers['Cookie'] = cookieHeader;
            }

            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                headers,
            });
            await writeMediaFile(localPath, Buffer.from(response.data));
            this.noteCloudMediaWrite(localPath);
            Logger.log(`[FileStorageService] Saved file: ${safeFilename}`);
            return this.toRelativePath(localPath);
        } catch (error: any) {
            const status: number | undefined = error?.response?.status;
            if (status === 409 || status === 403 || status === 401 || status === 410) {
                Logger.warn(`[FileStorageService] Skipping file (HTTP ${status}): ${url}`);
                return '';
            }
            Logger.error(`[FileStorageService] Failed to download file: ${error.message}`);
            throw error;
        }
    }

    /**
     * Convert the cookies JSON (tough-cookie SerializedCookieJar) to a Cookie header string
     */
    public static buildCookieHeader(cookiesJson: string): string {
        try {
            const jar = typeof cookiesJson === 'string' ? JSON.parse(cookiesJson) : cookiesJson;
            // tough-cookie SerializedCookieJar format: { cookies: [{key, value, ...}] }
            if (Array.isArray(jar?.cookies)) {
                return jar.cookies
                    .filter((c: any) => c.key && c.value)
                    .map((c: any) => `${c.key}=${c.value}`)
                    .join('; ');
            }
            // Fallback: raw string
            if (typeof jar === 'string') return jar;
        } catch {}
        return '';
    }

    /**
     * Download and save an image from a URL
     * @param cookiesJson - cookies JSON string from auth (tough-cookie SerializedCookieJar)
     * @param userAgent   - the account's User-Agent string
     */
    public static async downloadImage(
        zaloId: string,
        imageUrl: string,
        filename?: string,
        cookiesJson?: string,
        userAgent?: string,
        referer?: string,
    ): Promise<string> {
        try {
            // Zalo's JPEG XL images → download the JPG version (Chromium cannot display JXL)
            imageUrl = toZaloJpgUrl(imageUrl);
            const dir = this.getAccountDir(zaloId);
            const ext = this.getExtFromUrl(imageUrl) || '.jpg';
            // The name passed in by the caller must only be a file name (no folder, no "..")
            const fname = filename ? toSafeFileName(filename, `img_${Date.now()}${ext}`, { decodeUri: false }) : `img_${Date.now()}${ext}`;
            const localPath = path.join(dir, fname);

            const existing = await this.validateImageFileAsync(localPath);
            if (existing.valid) return this.toRelativePath(localPath);
            if (existing.reason !== 'not_found') {
                Logger.warn(`[FileStorageService] Corrupted image (${existing.reason}): ${fname}, will re-download`);
                await fs.promises.unlink(localPath).catch(() => {});
                // Fall through to download
            }

            const headers: Record<string, string> = {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': referer || 'https://chat.zalo.me/',
                // Boss's images (the employee machine saved them from MediaViewer) need the employee session token
                ...bossAuthHeaders(imageUrl),
            };
            if (cookiesJson) {
                const cookieHeader = this.buildCookieHeader(cookiesJson);
                if (cookieHeader) headers['Cookie'] = cookieHeader;
            }

            const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers,
            });

            await writeMediaFile(localPath, Buffer.from(response.data));
            this.noteCloudMediaWrite(localPath);
            Logger.log(`[FileStorageService] Saved image: ${fname}`);
            // Store as relative path (folder-agnostic - resolves via local-media:// handler)
            return this.toRelativePath(localPath);
        } catch (error: any) {
            const status: number | undefined = error?.response?.status;
            if (status === 409 || status === 403 || status === 401 || status === 410) {
                Logger.warn(`[FileStorageService] Skipping image (HTTP ${status}): ${imageUrl}`);
                return '';
            }
            Logger.error(`[FileStorageService] Failed to download image: ${error.message}`);
            throw error;
        }
    }

    /**
     * Download all attachments of a message
     */
    public static async downloadAttachments(zaloId: string, attachments: any[]): Promise<Record<string, string>> {
        const localPaths: Record<string, string> = {};

        for (const attachment of attachments) {
            try {
                const url = attachment.url || attachment.href || attachment.thumb;
                if (!url) continue;

                const localPath = await this.downloadImage(zaloId, url);
                localPaths[attachment.id || url] = localPath;
            } catch (error: any) {
                Logger.warn(`[FileStorageService] Failed to download attachment: ${error.message}`);
            }
        }

        return localPaths;
    }

    /**
     * Save a file from a buffer
     */
    public static async saveBuffer(zaloId: string, buffer: Buffer, filename: string): Promise<string> {
        const dir = this.getAccountDir(zaloId);
        const localPath = path.join(dir, toSafeFileName(filename, `file_${Date.now()}`, { decodeUri: false }));
        await writeMediaFile(localPath, buffer);
        this.noteCloudMediaWrite(localPath);
        return localPath;
    }

    /**
     * Get the extension from the URL
     */
    private static getExtFromUrl(url: string): string {
        try {
            const parsed = new URL(url);
            const pathname = parsed.pathname;
            const ext = path.extname(pathname);
            return ext || '.bin';
        } catch {
            return '.bin';
        }
    }

    /**
     * Get the list of files in the account's folder
     */
    public static getAccountFiles(zaloId: string): string[] {
        const baseDir = path.join(this.getBaseDir(), zaloId);
        if (!fs.existsSync(baseDir)) return [];

        const files: string[] = [];
        const dateDirs = fs.readdirSync(baseDir);
        for (const dateDir of dateDirs) {
            const fullPath = path.join(baseDir, dateDir);
            if (fs.statSync(fullPath).isDirectory()) {
                const dayFiles = fs.readdirSync(fullPath).map((f) => path.join(fullPath, f));
                files.push(...dayFiles);
            }
        }
        return files;
    }

    /**
     * Download a video from a URL, saving it with the correct extension
     */
    public static async downloadVideo(
        zaloId: string,
        videoUrl: string,
        filename?: string,
        cookiesJson?: string,
        userAgent?: string,
        /** Progress (bytes received, total; 0 when the server does not report it) → the progress ring on the video bubble (media/mediaProgress). */
        onProgress?: (received: number, total: number) => void,
    ): Promise<string> {
        try {
            const dir = this.getAccountDir(zaloId);
            // Determine the extension: try the URL first, fall back to mp4
            const urlPath = (() => { try { return new URL(videoUrl).pathname; } catch { return videoUrl; } })();
            const urlExt = path.extname(urlPath) || '';
            const ext = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v', '.3gp'].includes(urlExt.toLowerCase())
                ? urlExt.toLowerCase() : '.mp4';
            const fname = filename ? toSafeFileName(filename, `vid_${Date.now()}${ext}`, { decodeUri: false }) : `vid_${Date.now()}${ext}`;
            const localPath = path.join(dir, fname);

            const existing = await fs.promises.stat(localPath).catch(() => null);
            if (existing) {
                if (existing.size > 0) return this.toRelativePath(localPath);
                Logger.warn(`[FileStorageService] Corrupted video (empty): ${fname}, will re-download`);
                await fs.promises.unlink(localPath).catch(() => {});
                // Fall through to download
            }

            const headers: Record<string, string> = {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://chat.zalo.me/',
                // Boss's videos (the employee machine) need the employee session token
                ...bossAuthHeaders(videoUrl),
            };
            if (cookiesJson) {
                const cookieHeader = this.buildCookieHeader(cookiesJson);
                if (cookieHeader) headers['Cookie'] = cookieHeader;
            }

            const response = await axios.get(videoUrl, {
                responseType: 'arraybuffer',
                timeout: 120000,
                headers,
                maxContentLength: 200 * 1024 * 1024, // 200MB max
                ...(onProgress ? {
                    onDownloadProgress: (event: { loaded?: number; total?: number }) => {
                        try { onProgress(Number(event.loaded) || 0, Number(event.total) || 0); } catch {}
                    },
                } : {}),
            });
            await writeMediaFile(localPath, Buffer.from(response.data));
            this.noteCloudMediaWrite(localPath);
            Logger.log(`[FileStorageService] Saved video: ${fname}`);
            // Store as relative path (folder-agnostic)
            return this.toRelativePath(localPath);
        } catch (error: any) {
            const status: number | undefined = error?.response?.status;
            if (status === 409 || status === 403 || status === 401 || status === 410) {
                Logger.warn(`[FileStorageService] Skipping video (HTTP ${status}): ${videoUrl}`);
                return '';
            }
            Logger.error(`[FileStorageService] Failed to download video: ${error.message}`);
            throw error;
        }
    }

    /**
     * Delete the entire media folder of one account (including all its child files).
     */
    public static deleteAccountMedia(zaloId: string): void {
        const accountDir = path.join(this.getBaseDir(), zaloId);
        if (!fs.existsSync(accountDir)) {
            Logger.log(`[FileStorageService] Account media dir not found: ${accountDir}`);
            return;
        }
        try {
            fs.rmSync(accountDir, { recursive: true, force: true });
            Logger.log(`[FileStorageService] Deleted media for account: ${zaloId}`);
        } catch (error: any) {
            Logger.error(`[FileStorageService] Failed to delete media for account ${zaloId}: ${error.message}`);
        }
    }

    /**
     * Delete the day folders older than `olderThanDays` days in the account's media folder.
     * Structure: {baseDir}/{zaloId}/{YYYY-MM-DD}/files
     * @returns number of day folders deleted
     */
    public static cleanupOldMedia(zaloId: string, olderThanDays: number): number {
        // Media is stored to R2, AND "free up disk space" is on, AND the account is within the storage scope: only delete files that are verified
        // on R2 (runs in the background, HEAD before deleting). Files not yet backed up are kept, instead of deleting the whole day folder as before. Returns 0
        // because nothing is deleted at this point. Otherwise (R2 off, files kept on the machine: the default, or the account is out of scope) → clean up as before.
        try {
            if (require('../cloudflare/media').evictOldAccountMedia(zaloId, olderThanDays)) return 0;
        } catch { /* R2 module error → clean up as before */ }
        const accountDir = path.join(this.getBaseDir(), zaloId);
        if (!fs.existsSync(accountDir)) return 0;

        const cutoff = Date.now() - olderThanDays * 86400_000;
        let deletedCount = 0;

        try {
            const entries = fs.readdirSync(accountDir);
            for (const entry of entries) {
                const fullPath = path.join(accountDir, entry);
                try {
                    const stat = fs.statSync(fullPath);
                    if (!stat.isDirectory()) continue;

                    // Folder name in the YYYY-MM-DD format
                    const dirDate = new Date(entry + 'T00:00:00');
                    if (isNaN(dirDate.getTime())) continue;

                    if (dirDate.getTime() < cutoff) {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                        deletedCount++;
                    }
                } catch {
                    // Skip entries we can't stat
                    continue;
                }
            }
        } catch (error: any) {
            Logger.error(`[FileStorageService] cleanupOldMedia error for ${zaloId}: ${error.message}`);
        }

        if (deletedCount > 0) {
            Logger.log(`[FileStorageService] Cleaned ${deletedCount} old media dirs for ${zaloId} (older than ${olderThanDays}d)`);
        }
        return deletedCount;
    }

    /**
     * Delete a local file
     */
    public static deleteFile(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (error: any) {
            Logger.error(`[FileStorageService] Failed to delete file: ${error.message}`);
        }
    }
}

export default FileStorageService;

