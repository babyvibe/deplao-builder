/**
 * MediaCacheService - Employee-side disk cache cho media files.
 *
 * Khi employee xem ảnh lần đầu → download từ boss → lưu vào cache
 * Lần sau → dùng từ cache (không cần mạng)
 *
 * Cache location: app.getPath('cache')/media-cache/
 * LRU eviction khi vượt quá dung lượng cho phép.
 *
 * Chỉ hoạt động trong employee mode.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Logger from '../../utils/Logger';

interface CacheEntry {
  key: string;
  size: number;
  accessedAt: number;
  createdAt: number;
  url: string;         // Boss URL gốc
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
  // Track failed URLs để không retry liên tục
  private failedUrls = new Map<string, number>(); // url → timestamp

  public static getInstance(): MediaCacheService {
    if (!MediaCacheService.instance) {
      MediaCacheService.instance = new MediaCacheService();
    }
    return MediaCacheService.instance;
  }

  /** Khởi tạo cache folder và load index */
  public init(customCacheDir?: string): void {
    try {
      this.cacheDir = customCacheDir || this.getDefaultCacheDir();
      this.indexPath = path.join(this.cacheDir, 'index.json');

      // Tạo folder nếu chưa có
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
   * Lấy URL để hiển thị media:
   * - Có trong cache → trả về file:// URL
   * - Không có → trả về boss URL để fetch, đồng thời download background
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

    // Cache hit
    if (cached && fs.existsSync(this.getCacheFilePath(cacheKey))) {
      cached.accessedAt = Date.now();
      this.saveIndex();
      return {
        displayUrl: this.getCacheFileUrl(cacheKey, cached.mimeType),
        fromCache: true,
      };
    }

    // Cache miss → download background
    this.downloadToCache(bossUrl, cacheKey, mediaType).catch(() => {});
    return { displayUrl: bossUrl, fromCache: false };
  }

  /** Check xem có cache không (sync, nhanh) */
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

  /** Download file từ boss vào cache */
  private async downloadToCache(bossUrl: string, cacheKey: string, mediaType: string): Promise<void> {
    await this.acquireSlot();
    try {
      // Skip nếu đã thất bại trong 5 phút qua
      const lastFail = this.failedUrls.get(bossUrl);
      if (lastFail && Date.now() - lastFail < 5 * 60 * 1000) return;

      Logger.log(`[MediaCacheService] Downloading: ${bossUrl.slice(0, 80)}...`);

      const response = await fetch(bossUrl, {
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        Logger.warn(`[MediaCacheService] Download failed: HTTP ${response.status}`);
        this.failedUrls.set(bossUrl, Date.now());
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get('content-type') || this.guessMimeFromUrl(bossUrl);
      const filePath = this.getCacheFilePath(cacheKey);

      // Lưu file
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, buffer);

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

      Logger.log(`[MediaCacheService] Cached: ${(buffer.length / 1024).toFixed(1)}KB`);
    } catch (err: any) {
      // Timeout/network error — không track failed để có thể retry sau
      Logger.warn(`[MediaCacheService] Download error: ${err.message}`);
    } finally {
      this.releaseSlot();
    }
  }

  /** Xoá cache cũ nếu vượt quá dung lượng */
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

  /** Xoá cache cũ hơn N ngày (gọi định kỳ) */
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

  /** Reset hoàn toàn cache */
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
    // Dùng file:// protocol, Electron CSP cho phép
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

  private getDefaultCacheDir(): string {
    try {
      const { app } = require('electron');
      return path.join(app.getPath('cache'), 'media-cache');
    } catch {
      // Fallback khi không ở trong Electron (dev/test)
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
