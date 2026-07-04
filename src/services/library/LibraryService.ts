/**
 * LibraryService - Quản lý thư viện media dùng chung (ảnh, file, video).
 *
 * Lưu trên boss storage, employee truy cập qua REST API.
 * Upload qua multipart/form-data, thumbnail tự động gen.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import DatabaseService from '../database/DatabaseService';
import FileStorageService from '../file/FileStorageService';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';

export interface LibraryItem {
  uuid: string;
  owner_zalo_id: string;
  type: 'image' | 'file' | 'video';
  name: string;
  mime_type: string;
  size: number;
  width: number;
  height: number;
  file_path: string;
  thumb_path: string | null;
  alt_text: string;
  tags: string;
  folder_id: number | null;
  is_favorite: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface LibraryFolder {
  id: number;
  name: string;
  parent_id: number | null;
  owner_zalo_id: string;
  color: string;
  sort_order: number;
  item_count?: number;
}

const THUMB_SIZE = 320;

class LibraryService {
  private static instance: LibraryService;

  public static getInstance(): LibraryService {
    if (!LibraryService.instance) {
      LibraryService.instance = new LibraryService();
    }
    return LibraryService.instance;
  }

  // ─── Storage paths ───────────────────────────────────────────────

  private getLibraryDir(zaloId: string): string {
    const base = FileStorageService.getBaseDir();
    return path.join(base, 'library', zaloId);
  }

  private getTypeDir(zaloId: string, type: string): string {
    return path.join(this.getLibraryDir(zaloId), `${type}s`);
  }

  private getThumbDir(zaloId: string): string {
    return path.join(this.getLibraryDir(zaloId), 'thumbs');
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ─── Upload ──────────────────────────────────────────────────────

  /**
   * Upload file vào thư viện.
   * @returns LibraryItem info
   */
  public async upload(params: {
    zaloId: string;
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    employeeId?: string;
    tags?: string;
    folderId?: number | null;
  }): Promise<LibraryItem> {
    const { zaloId, buffer, fileName, mimeType, employeeId, tags, folderId } = params;

    const uuid = uuidv4();
    const ext = path.extname(fileName) || '.bin';
    const type = this.detectType(mimeType, ext);
    const typeDir = this.getTypeDir(zaloId, type);
    const thumbDir = this.getThumbDir(zaloId);

    this.ensureDir(typeDir);
    this.ensureDir(thumbDir);

    // Save file
    const filePath = path.join(typeDir, `${uuid}${ext}`);
    fs.writeFileSync(filePath, buffer);

    // Dimensions (chỉ cho ảnh)
    let width = 0;
    let height = 0;
    let thumbPath: string | null = null;

    if (type === 'image') {
      try {
        const sharp = require('sharp');
        const meta = await sharp(buffer).metadata();
        width = meta.width || 0;
        height = meta.height || 0;

        // Generate thumbnail
        const thumbName = `${uuid}_thumb.jpg`;
        thumbPath = path.join(thumbDir, thumbName);
        await sharp(buffer)
          .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(thumbPath);
      } catch (err: any) {
        Logger.warn(`[LibraryService] Thumbnail gen error: ${err.message}`);
      }
    }

    if (type === 'video') {
      try {
        const sharp = require('sharp');
        const thumbName = `${uuid}_thumb.jpg`;
        thumbPath = path.join(thumbDir, thumbName);
        // For videos, create a placeholder thumbnail
        await sharp({
          create: { width: 320, height: 240, channels: 3, background: { r: 30, g: 30, b: 30 } }
        })
          .jpeg({ quality: 60 })
          .toFile(thumbPath);
      } catch {}
    }

    const now = Date.now();
    const db = DatabaseService.getInstance();

    const relativeFilePath = filePath;
    const relativeThumbPath = thumbPath;

    db.run(
      `INSERT INTO media_library_items
       (uuid, owner_zalo_id, type, name, mime_type, size, width, height,
        file_path, thumb_path, alt_text, tags, folder_id, is_favorite, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid, zaloId, type, fileName, mimeType, buffer.length, width, height,
       relativeFilePath, relativeThumbPath, '', tags || '', folderId ?? null, 0, employeeId || '', now, now]
    );

    const item: LibraryItem = {
      uuid, owner_zalo_id: zaloId, type: type as any, name: fileName,
      mime_type: mimeType, size: buffer.length, width, height,
      file_path: relativeFilePath, thumb_path: relativeThumbPath,
      alt_text: '', tags: tags || '', folder_id: folderId ?? null,
      is_favorite: 0, created_by: employeeId || '', created_at: now, updated_at: now,
    };

    EventBroadcaster.emit('library:itemAdded', { zaloId, item, uuid });

    Logger.log(`[LibraryService] Uploaded: ${fileName} (${(buffer.length / 1024).toFixed(1)}KB) type=${type}`);
    return item;
  }

  // ─── Query ───────────────────────────────────────────────────────

  public getItems(params: {
    zaloId: string;
    type?: string;
    search?: string;
    folderId?: number | null;
    page?: number;
    limit?: number;
  }): { items: LibraryItem[]; total: number } {
    const { zaloId, type, search, folderId, page = 1, limit = 50 } = params;
    const db = DatabaseService.getInstance();
    const conditions: string[] = ['owner_zalo_id = ?'];
    const values: any[] = [zaloId];

    if (type && type !== 'all') {
      conditions.push('type = ?');
      values.push(type);
    }

    if (search) {
      conditions.push('(name LIKE ? OR tags LIKE ? OR alt_text LIKE ?)');
      const q = `%${search}%`;
      values.push(q, q, q);
    }

    if (folderId !== undefined && folderId !== null) {
      if (folderId === -1) {
        conditions.push('folder_id IS NULL');
      } else {
        conditions.push('folder_id = ?');
        values.push(folderId);
      }
    }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const total = db.queryOne<any>(`SELECT COUNT(*) as n FROM media_library_items WHERE ${where}`, values)?.n || 0;
    const items = db.query<any>(
      `SELECT * FROM media_library_items WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...values, limit, offset]
    ) || [];

    return { items, total };
  }

  public getItem(uuid: string): LibraryItem | null {
    const db = DatabaseService.getInstance();
    return db.queryOne<LibraryItem>('SELECT * FROM media_library_items WHERE uuid = ?', [uuid]) || null;
  }

  public updateItem(uuid: string, params: {
    name?: string; tags?: string; folderId?: number | null;
    isFavorite?: number; altText?: string;
  }): boolean {
    const db = DatabaseService.getInstance();
    const sets: string[] = [];
    const values: any[] = [];

    if (params.name !== undefined) { sets.push('name = ?'); values.push(params.name); }
    if (params.tags !== undefined) { sets.push('tags = ?'); values.push(params.tags); }
    if (params.folderId !== undefined) { sets.push('folder_id = ?'); values.push(params.folderId); }
    if (params.isFavorite !== undefined) { sets.push('is_favorite = ?'); values.push(params.isFavorite); }
    if (params.altText !== undefined) { sets.push('alt_text = ?'); values.push(params.altText); }

    if (sets.length === 0) return false;

    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(uuid);

    db.run(`UPDATE media_library_items SET ${sets.join(', ')} WHERE uuid = ?`, values);
    EventBroadcaster.emit('library:itemUpdated', { uuid, ...params });
    return true;
  }

  public deleteItem(uuid: string): boolean {
    const db = DatabaseService.getInstance();
    const item = this.getItem(uuid);
    if (!item) return false;

    // Xoá file
    try { if (fs.existsSync(item.file_path)) fs.unlinkSync(item.file_path); } catch {}
    try { if (item.thumb_path && fs.existsSync(item.thumb_path)) fs.unlinkSync(item.thumb_path); } catch {}

    db.run('DELETE FROM media_library_items WHERE uuid = ?', [uuid]);
    EventBroadcaster.emit('library:itemDeleted', { uuid, zaloId: item.owner_zalo_id });
    return true;
  }

  // ─── Folders ─────────────────────────────────────────────────────

  public createFolder(params: {
    name: string; zaloId: string; parentId?: number | null; color?: string; type?: string;
  }): number {
    const db = DatabaseService.getInstance();
    const sort = (db.queryOne<any>('SELECT MAX(sort_order) as m FROM media_library_folders WHERE owner_zalo_id=?', [params.zaloId])?.m || 0) + 1;
    const id = db.runInsert(
      'INSERT INTO media_library_folders (name, parent_id, owner_zalo_id, color, sort_order, type) VALUES (?,?,?,?,?,?)',
      [params.name, params.parentId ?? null, params.zaloId, params.color || '#6366f1', sort, params.type || null]
    );
    return id;
  }

  public getFolders(zaloId: string, type?: string): LibraryFolder[] {
    const db = DatabaseService.getInstance();
    const conditions = ['f.owner_zalo_id = ?'];
    const values: any[] = [zaloId];
    if (type && type !== 'all') {
      // Chỉ load folder đúng type, bỏ qua folder cũ ko có type
      conditions.push('f.type = ?');
      values.push(type);
    }
    const folders = db.query<any>(
      `SELECT f.*,
        (SELECT COUNT(*) FROM media_library_items i WHERE i.folder_id = f.id ${type ? `AND i.type = '${type}'` : ''}) as item_count
       FROM media_library_folders f WHERE ${conditions.join(' AND ')} ORDER BY f.sort_order ASC`,
      values
    ) || [];
    return folders;
  }

  public deleteFolder(id: number): boolean {
    const db = DatabaseService.getInstance();
    db.run('UPDATE media_library_items SET folder_id = NULL WHERE folder_id = ?', [id]);
    db.run('DELETE FROM media_library_folders WHERE id = ?', [id]);
    return true;
  }

  // ─── Serve file ──────────────────────────────────────────────────

  public getFilePath(uuid: string): { filePath: string; mimeType: string; fileName: string } | null {
    const item = this.getItem(uuid);
    if (!item || !fs.existsSync(item.file_path)) return null;
    return { filePath: item.file_path, mimeType: item.mime_type, fileName: item.name };
  }

  public getThumbPath(uuid: string): { filePath: string; mimeType: string } | null {
    const item = this.getItem(uuid);
    if (!item || !item.thumb_path || !fs.existsSync(item.thumb_path)) return null;
    return { filePath: item.thumb_path, mimeType: 'image/jpeg' };
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private detectType(mime: string, ext: string): string {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf' || mime.startsWith('application/') || mime.startsWith('text/')
        || ['.doc','.docx','.xls','.xlsx','.ppt','.pptx','.zip','.rar','.txt','.csv'].includes(ext)) {
      return 'file';
    }
    return 'file';
  }

  // ─── Migration: create tables ────────────────────────────────────

  public migrate(): void {
    const db = DatabaseService.getInstance();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS media_library_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          owner_zalo_id TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'image',
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL DEFAULT '',
          size INTEGER NOT NULL DEFAULT 0,
          width INTEGER NOT NULL DEFAULT 0,
          height INTEGER NOT NULL DEFAULT 0,
          file_path TEXT NOT NULL DEFAULT '',
          thumb_path TEXT DEFAULT NULL,
          alt_text TEXT DEFAULT '',
          tags TEXT DEFAULT '',
          folder_id INTEGER DEFAULT NULL,
          is_favorite INTEGER DEFAULT 0,
          created_by TEXT DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS media_library_folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          parent_id INTEGER DEFAULT NULL,
          owner_zalo_id TEXT NOT NULL,
          color TEXT DEFAULT '#6366f1',
          sort_order INTEGER DEFAULT 0
        )
      `);
      // Thêm cột type nếu chưa có (migration)
      try { db.exec(`ALTER TABLE media_library_folders ADD COLUMN type TEXT DEFAULT NULL`); } catch {}
      db.exec(`CREATE INDEX IF NOT EXISTS idx_library_owner ON media_library_items(owner_zalo_id, type, created_at)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_library_folder ON media_library_items(folder_id)`);
      Logger.log('[LibraryService] ✅ Tables migrated');
    } catch (err: any) {
      Logger.warn(`[LibraryService] Migration error: ${err.message}`);
    }
  }
}

export default LibraryService;
