/**
 * MediaCacheService - Employee-side disk cache for media files.
 *
 * When an employee views an image for the first time → download from the boss → save to the cache
 * Next time → use the cache (no network needed)
 *
 * Cache location: app.getPath('cache')/media-cache/
 * LRU eviction when the allowed size is exceeded.
 *
 * Only works in employee mode.
 */

import * as fs from 'fs';
import * as path from 'path';
import { writeMediaFile } from '../file/writeMediaFile';
import * as crypto from 'crypto';
import Logger from '../../utils/Logger';
import FileStorageService from '../file/FileStorageService';
import { bossAuthHeaders } from '../http/bossSessionAuth';
import { decodeUrlPath, isPathInside } from '../http/bossFileAccess';

interface CacheEntry {
  key: string;
  size: number;
  accessedAt: number;
  createdAt: number;
  url: string;         // Original boss URL
  mimeType: string;
}

class MediaCacheService {
  private static instance: MediaCacheService;
  private cacheDir: string = '';
  private maxSizeBytes: number = 2 * 1024 * 1024 * 1024; // 2GB default
  private indexPath: string = '';
  private index: Map<string, CacheEntry> = new Map();
  private initialized = false;

  // ── Concurrency control ──────────────────────────────────────
  private maxConcurrent = 3;
  private activeCount = 0;
  private pendingQueue: Array<() => void> = [];
  // Track failed URLs so they are not retried over and over
  private failedUrls = new Map<string, number>(); // url → timestamp

  public static getInstance(): MediaCacheService {
    if (!MediaCacheService.instance) {
      MediaCacheService.instance = new MediaCacheService();
    }
    return MediaCacheService.instance;
  }

  /** Initialize the cache folder and load the index */
  public init(customCacheDir?: string): void {
    try {
      this.cacheDir = customCacheDir || this.getDefaultCacheDir();
      this.indexPath = path.join(this.cacheDir, 'index.json');

      // Create the folder if it does not exist yet
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }

      // Load index
      this.loadIndex();

      this.initialized = true;
      Logger.log(`[MediaCacheService] Initialized: ${this.cacheDir} (max ${(this.maxSizeBytes / 1024 / 1024 / 1024).toFixed(1)}GB)`);
    } catch (err: any) {
      Logger.warn(`[MediaCacheService] Init error: ${err.message}`);
    }
  }

  /**
   * Get the URL to display media:
   * - In the cache → returns a file:// URL
   * - Not in the cache → returns the boss URL to fetch, and downloads in the background at the same time
   */
  public async resolveUrl(bossUrl: string, mediaType: 'avatar' | 'image' | 'file' = 'image'): Promise<{
    displayUrl: string;
    fromCache: boolean;
  }> {
    if (!this.initialized) {
      return { displayUrl: bossUrl, fromCache: false };
    }

    const cacheKey = this.hashUrl(bossUrl);
    const cached = this.index.get(cacheKey);

    // Cache hit (hash-based)
    if (cached && fs.existsSync(this.getCacheFilePath(cacheKey))) {
      cached.accessedAt = Date.now();
      this.saveIndex();
      return {
        displayUrl: this.getCacheFileUrl(cacheKey, cached.mimeType),
        fromCache: true,
      };
    }

    // Cache miss → check the structured media folder (it may have been downloaded last time)
    try {
      const structuredPath = this.getLocalCopyPath(bossUrl);
      if (structuredPath) {
        return { displayUrl: `file:///${structuredPath.replace(/\\/g, '/').replace(/^\//, '')}`, fromCache: true };
      }
    } catch {}

    // Cache miss → download background
    this.downloadToCache(bossUrl, cacheKey, mediaType).catch(() => {});
    return { displayUrl: bossUrl, fromCache: false };
  }

  /**
   * Resolve the URL cache-first, but WAIT for the download to finish on a cache miss.
   * Used when the user clicks to open a file/media (a local file is needed right away).
   */
  public async resolveUrlSync(bossUrl: string, mediaType: 'avatar' | 'image' | 'file' = 'image'): Promise<{
    displayUrl: string;
    fromCache: boolean;
  }> {
    if (!this.initialized) {
      return { displayUrl: bossUrl, fromCache: false };
    }

    const cacheKey = this.hashUrl(bossUrl);
    const cached = this.index.get(cacheKey);

    // Cache hit
    if (cached && fs.existsSync(this.getCacheFilePath(cacheKey))) {
      cached.accessedAt = Date.now();
      this.saveIndex();
      return {
        displayUrl: this.getCacheFileUrl(cacheKey, cached.mimeType),
        fromCache: true,
      };
    }

    // Cache miss → download SYNCHRONOUSLY (wait until it finishes)
    try {
      await this.downloadToCache(bossUrl, cacheKey, mediaType);
      // Check again after the download
      const entry = this.index.get(cacheKey);
      if (entry && fs.existsSync(this.getCacheFilePath(cacheKey))) {
        return {
          displayUrl: this.getCacheFileUrl(cacheKey, entry.mimeType),
          fromCache: true,
        };
      }
    } catch (err: any) {
      Logger.warn(`[MediaCacheService] resolveUrlSync failed: ${err.message}`);
    }

    return { displayUrl: bossUrl, fromCache: false };
  }

  /** Check whether the cache exists (sync, fast) */
  public hasCache(bossUrl: string): boolean {
    const key = this.hashUrl(bossUrl);
    const entry = this.index.get(key);
    return !!entry && fs.existsSync(this.getCacheFilePath(key));
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return;
    }
    return new Promise((resolve) => {
      this.pendingQueue.push(resolve);
    });
  }

  private releaseSlot(): void {
    if (this.pendingQueue.length > 0) {
      const next = this.pendingQueue.shift();
      if (next) next();
    } else {
      this.activeCount--;
    }
  }

  /** Download the file from the boss into the cache + save it in the right media/ folder */
  private async downloadToCache(bossUrl: string, cacheKey: string, mediaType: string): Promise<void> {
    await this.acquireSlot();
    try {
      // Skip if it failed within the last 5 minutes
      const lastFail = this.failedUrls.get(bossUrl);
      if (lastFail && Date.now() - lastFail < 5 * 60 * 1000) return;

      Logger.log(`[MediaCacheService] Downloading: ${bossUrl.slice(0, 80)}...`);

      // The boss requires an employee session for /api/media and /api/library (bossSessionAuth: Boss URL → token).
      // Video / file: when the user clicks to open → download everything, then open it (the boss URL cannot be opened in an external browser) → allow more time.
      const response = await fetch(bossUrl, {
        headers: bossAuthHeaders(bossUrl),
        signal: AbortSignal.timeout(mediaType === 'video' || mediaType === 'file' ? 10 * 60_000 : 30_000),
      });

      if (!response.ok) {
        Logger.warn(`[MediaCacheService] Download failed: HTTP ${response.status}`);
        // 401 = no session yet / session expired (connecting, logging in again) → can retry as soon as a token exists, not pinned for 5 minutes
        if (response.status !== 401) this.failedUrls.set(bossUrl, Date.now());
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type') || this.guessMimeFromUrl(bossUrl);
      const filePath = this.getCacheFilePath(cacheKey);

      // Save the hash-based cache
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      await writeMediaFile(filePath, buffer);

      // Ghi index
      this.index.set(cacheKey, {
        key: cacheKey,
        size: buffer.length,
        accessedAt: Date.now(),
        createdAt: Date.now(),
        url: bossUrl,
        mimeType,
      });
      this.saveIndex();
      this.evictIfNeeded();

      // Also save to the structured media folder if the boss URL contains the correct path
      // VD: https://boss/api/media/zaloId/2024-06-27/video.mp4
      try {
        const structuredPath = this.structuredPathFor(bossUrl);
        if (structuredPath) {
          const structuredDir = path.dirname(structuredPath);
          await fs.promises.mkdir(structuredDir, { recursive: true });
          const already = await fs.promises.stat(structuredPath).then(() => true, () => false);
          if (!already) await writeMediaFile(structuredPath, buffer);
          Logger.log(`[MediaCacheService] Also saved to: ${structuredPath}`);
        }
      } catch {}

      Logger.log(`[MediaCacheService] Cached: ${(buffer.length / 1024).toFixed(1)}KB`);
    } catch (err: any) {
      // Timeout/network error: do not track as failed, so it can be retried later
      Logger.warn(`[MediaCacheService] Download error: ${err.message}`);
    } finally {
      this.releaseSlot();
    }
  }

  /** Delete old cache entries when the size limit is exceeded */
  private evictIfNeeded(): void {
    let totalSize = 0;
    const entries: CacheEntry[] = [];

    for (const entry of this.index.values()) {
      totalSize += entry.size;
      entries.push(entry);
    }

    if (totalSize <= this.maxSizeBytes) return;

    // Sort by accessedAt (oldest first)
    entries.sort((a, b) => a.accessedAt - b.accessedAt);

    const toDelete: string[] = [];
    for (const entry of entries) {
      if (totalSize <= this.maxSizeBytes) break;
      toDelete.push(entry.key);
      totalSize -= entry.size;
    }

    for (const key of toDelete) {
      try {
        const fp = this.getCacheFilePath(key);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        this.index.delete(key);
      } catch {}
    }

    this.saveIndex();
    Logger.log(`[MediaCacheService] Evicted ${toDelete.length} files, freed ${(totalSize / 1024 / 1024).toFixed(0)}MB`);
  }

  /** Delete cache entries older than N days (called periodically) */
  public cleanOldCache(maxAgeDays = 7): void {
    const now = Date.now();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    const toDelete: string[] = [];

    for (const [key, entry] of this.index) {
      if (now - entry.createdAt > maxAge) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      try {
        const fp = this.getCacheFilePath(key);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        this.index.delete(key);
      } catch {}
    }

    if (toDelete.length > 0) {
      this.saveIndex();
      Logger.log(`[MediaCacheService] Cleaned ${toDelete.length} old cache files`);
    }
  }

  /** Fully reset the cache */
  public clear(): void {
    try {
      for (const key of this.index.keys()) {
        try {
          fs.unlinkSync(this.getCacheFilePath(key));
        } catch {}
      }
      this.index.clear();
      this.saveIndex();
      Logger.log('[MediaCacheService] Cache cleared');
    } catch {}
  }

  // ── Helpers ──────────────────────────────────────────────────

  private hashUrl(url: string): string {
    return crypto.createHash('md5').update(url).digest('hex');
  }

  private getCacheFilePath(key: string): string {
    return path.join(this.cacheDir, key.slice(0, 2), key);
  }

  private getCacheFileUrl(key: string, mimeType: string): string {
    const fp = this.getCacheFilePath(key);
    // Uses the file:// protocol, which the Electron CSP allows
    const normalized = fp.replace(/\\/g, '/');
    return `file:///${normalized.startsWith('/') ? '' : '/'}${normalized}`;
  }

  private guessMimeFromUrl(url: string): string {
    const ext = path.extname(url).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
      '.pdf': 'application/pdf', '.mp3': 'audio/mpeg',
    };
    return mimeMap[ext] || 'application/octet-stream';
  }

  /**
   * A copy that keeps the exact name + extension in the workspace's media folder (downloadToCache writes it in parallel with the hash cache):
   * if it is already on the machine, returns the path, otherwise ''. Used when opening / showing the file in its folder (the hash cache file has no extension).
   */
  public getLocalCopyPath(bossUrl: string): string {
    try {
      const structuredPath = this.structuredPathFor(bossUrl);
      return structuredPath && fs.statSync(structuredPath).isFile() ? structuredPath : '';
    } catch {
      return '';
    }
  }

  /**
   * A copy with the exact name + extension in the media folder, made from the cache file. The cache is named by hash with no extension,
   * so the default app cannot open it. Used when the cache exists but the copy does not (downloaded before the copy existed, the media folder was cleared…).
   */
  public ensureLocalCopy(bossUrl: string, sourcePath: string): string {
    try {
      const structuredPath = this.structuredPathFor(bossUrl);
      if (!structuredPath || !sourcePath || !fs.existsSync(sourcePath)) return '';
      if (!fs.existsSync(structuredPath)) {
        fs.mkdirSync(path.dirname(structuredPath), { recursive: true });
        fs.copyFileSync(sourcePath, structuredPath);
      }
      return structuredPath;
    } catch {
      return '';
    }
  }

  /** Path in the workspace's media folder for the boss URL ('' if it cannot be derived / would leave the media folder). */
  private structuredPathFor(bossUrl: string): string {
    const mediaRelPath = this.extractMediaRelPath(bossUrl);
    if (!mediaRelPath) return '';
    let mediaBaseDir = FileStorageService.getBaseDir?.() || '';
    if (!mediaBaseDir) {
      const { app } = require('electron');
      mediaBaseDir = path.join(app.getPath('userData'), 'media');
    }
    const structuredPath = path.resolve(mediaBaseDir, mediaRelPath);
    // Odd URLs (../, absolute paths) must not be written to or read from outside the media folder
    return isPathInside(path.resolve(mediaBaseDir), structuredPath) && structuredPath !== path.resolve(mediaBaseDir)
      ? structuredPath
      : '';
  }

  /** Extract the relative path from the boss URL to save it in the right media/zaloId/date/ folder
   *  e.g.: https://boss/api/media/2231125334791940537/2024/06/27/video.mp4
   *    → 2231125334791940537/2024/06/27/video.mp4
   *  e.g.: https://boss/api/media/thumb/2231125334791940537/2024/06/27/thumb.jpg
   *    → thumb/2231125334791940537/2024/06/27/thumb.jpg
   */
  private extractMediaRelPath(bossUrl: string): string {
    try {
      // Match /api/media/ or /api/avatar/... → drop ?query/#hash, decode the file name (the URL is encoded per segment: "#", "%"…)
      const match = bossUrl.split(/[?#]/)[0].match(/\/api\/(?:media|avatar|_uploads)\/(.+)/);
      if (match) return decodeUrlPath(match[1]);
      // Fallback: take the pathname from the URL
      const urlObj = new URL(bossUrl);
      const pathname = urlObj.pathname.replace(/^\/api\//, '');
      return pathname || '';
    } catch { return ''; }
  }

  private getDefaultCacheDir(): string {
    try {
      const { app } = require('electron');
      return path.join(app.getPath('cache'), 'media-cache');
    } catch {
      // Fallback when not running inside Electron (dev/test)
      return path.join(process.cwd(), '.cache', 'media');
    }
  }

  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexPath)) {
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.index = new Map(Object.entries(data));
      }
    } catch {}
  }

  private saveIndex(): void {
    try {
      const dir = path.dirname(this.indexPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const obj: Record<string, CacheEntry> = {};
      for (const [k, v] of this.index) {
        obj[k] = v;
      }
      fs.writeFileSync(this.indexPath, JSON.stringify(obj));
    } catch {}
  }
}

export default MediaCacheService;
