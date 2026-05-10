import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { app } from 'electron';
import Logger from '../utils/Logger';

class FileStorageService {
    private static baseDir: string = '';

    /**
     * Resolve thư mục media gốc dựa theo workspace hiện tại.
     * - Default workspace: dbFolder/media/
     * - Additional workspaces: dbFolder/workspace-{id}/media/
     * Gọi lần đầu sẽ đọc config, sau đó cache vào static field.
     */
    public static getBaseDir(): string {
        if (!this.baseDir) {
            // Try workspace-aware resolution first
            try {
                const WorkspaceManager = require('../utils/WorkspaceManager').default;
                const wm = WorkspaceManager.getInstance();
                this.baseDir = wm.getActiveMediaPath();
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
     * Reset cache khi người dùng thay đổi storage path (gọi sau khi lưu config mới).
     */
    public static resetBaseDir(): void {
        this.baseDir = '';
        Logger.log('[FileStorageService] Base dir cache cleared, will re-resolve on next access');
    }

    /**
     * Convert an absolute path to a path relative to the config folder (parent of media/).
     * Returns "media/zaloId/date/img.jpg" — folder-agnostic: only the part after the
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
        // Absolute path — serve as-is if it exists
        if (fs.existsSync(relOrAbsPath)) return relOrAbsPath;
        // File not found (old drive/folder after move) — remap via /media/ marker
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
     * Lấy đường dẫn thư mục media cho một tài khoản
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
     * Download và lưu file đính kèm với tên file đúng (không dùng img_ prefix)
     * @param cookiesJson - cookies JSON string từ auth (tough-cookie SerializedCookieJar)
     * @param userAgent   - User-Agent string của account
     */
    public static async downloadFile(
        zaloId: string,
        url: string,
        filename: string,
        cookiesJson?: string,
        userAgent?: string,
    ): Promise<string> {
        try {
            const dir = this.getAccountDir(zaloId);
            // Sanitize filename
            const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '_').trim() || `file_${Date.now()}`;
            const localPath = path.join(dir, safeFilename);

            if (fs.existsSync(localPath)) {
                return this.toRelativePath(localPath); // Already downloaded
            }

            const headers: Record<string, string> = {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://chat.zalo.me/',
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
            fs.writeFileSync(localPath, Buffer.from(response.data));
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
     * Chuyển đổi cookies JSON (tough-cookie SerializedCookieJar) sang header Cookie string
     */
    private static buildCookieHeader(cookiesJson: string): string {
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
     * Download và lưu ảnh từ URL
     * @param cookiesJson - cookies JSON string từ auth (tough-cookie SerializedCookieJar)
     * @param userAgent   - User-Agent string của account
     */
    public static async downloadImage(
        zaloId: string,
        imageUrl: string,
        filename?: string,
        cookiesJson?: string,
        userAgent?: string,
    ): Promise<string> {
        try {
            const dir = this.getAccountDir(zaloId);
            const ext = this.getExtFromUrl(imageUrl) || '.jpg';
            const fname = filename || `img_${Date.now()}${ext}`;
            const localPath = path.join(dir, fname);

            if (fs.existsSync(localPath)) {
                // Return relative path so the DB entry is folder-agnostic
                return this.toRelativePath(localPath);
            }

            const headers: Record<string, string> = {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://chat.zalo.me/',
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

            fs.writeFileSync(localPath, Buffer.from(response.data));
            Logger.log(`[FileStorageService] Saved image: ${fname}`);
            // Store as relative path (folder-agnostic — resolves via local-media:// handler)
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
     * Download tất cả attachments của một message
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
     * Lưu file từ buffer
     */
    public static async saveBuffer(zaloId: string, buffer: Buffer, filename: string): Promise<string> {
        const dir = this.getAccountDir(zaloId);
        const localPath = path.join(dir, filename);
        fs.writeFileSync(localPath, buffer);
        return localPath;
    }

    /**
     * Lấy extension từ URL
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
     * Lấy danh sách file trong thư mục của account
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
     * Download video từ URL, lưu với đúng extension
     */
    public static async downloadVideo(
        zaloId: string,
        videoUrl: string,
        filename?: string,
        cookiesJson?: string,
        userAgent?: string,
    ): Promise<string> {
        try {
            const dir = this.getAccountDir(zaloId);
            // Xác định extension: cố gắng lấy từ URL, fallback mp4
            const urlPath = (() => { try { return new URL(videoUrl).pathname; } catch { return videoUrl; } })();
            const urlExt = path.extname(urlPath) || '';
            const ext = ['.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v', '.3gp'].includes(urlExt.toLowerCase())
                ? urlExt.toLowerCase() : '.mp4';
            const fname = filename || `vid_${Date.now()}${ext}`;
            const localPath = path.join(dir, fname);

            if (fs.existsSync(localPath)) {
                return this.toRelativePath(localPath);
            }

            const headers: Record<string, string> = {
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://chat.zalo.me/',
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
            });
            fs.writeFileSync(localPath, Buffer.from(response.data));
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
     * Xóa file local
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

