/**
 * FacebookScanTabService.ts
 * Quản lý tab scan + data + request logs trong DB.
 * Mỗi tab = 1 phiên quét (có cài đặt, dữ liệu, lịch sử request).
 */

import DatabaseService from '../../database/DatabaseService';
import Logger from '../../../utils/Logger';

// ─── Types ───────────────────────────────────────────────────────────

export type TabStatus = 'active' | 'archived' | 'deleted';

export interface ScanTabRecord {
  id: string;
  accountId: string;
  name: string;
  scanType: string;
  config: string;          // JSON: scanType, url, keyword, batchMode, batchInput, threadCount, filters
  status: TabStatus;
  itemsCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScanTabDataRecord {
  id: number;
  tabId: string;
  items: string;   // JSON array
  totalCount: number;
  pageInfo: string; // JSON { endCursor, hasNextPage }
  createdAt: number;
}

export interface ScanTabRequestRecord {
  id: number;
  tabId: string;
  requestPayload: string;   // JSON: params, variables, docId, friendlyName
  responsePreview: string;  // 500 ký tự đầu response
  status: 'success' | 'error';
  error: string;
  itemsCount: number;
  createdAt: number;
}

// ─── Service ─────────────────────────────────────────────────────────

export class FacebookScanTabService {
  private static initialized = false;

  static init(): void {
    if (this.initialized) return;
    try {
      const db = DatabaseService.getInstance();
      // ⚠️ BẮT BUỘC: SQLite mặc định tắt foreign keys → CASCADE không hoạt động!
      db.run('PRAGMA foreign_keys = ON');
      db.exec(`
        CREATE TABLE IF NOT EXISTS fb_scan_tabs (
          id            TEXT PRIMARY KEY,
          account_id    TEXT NOT NULL,
          name          TEXT NOT NULL DEFAULT 'Scan',
          scan_type     TEXT NOT NULL,
          config        TEXT NOT NULL DEFAULT '{}',
          status        TEXT NOT NULL DEFAULT 'active',
          items_count   INTEGER DEFAULT 0,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scan_tabs_account ON fb_scan_tabs(account_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS fb_scan_tab_data (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          tab_id        TEXT NOT NULL,
          items         TEXT NOT NULL DEFAULT '[]',
          total_count   INTEGER DEFAULT 0,
          page_info     TEXT DEFAULT '{}',
          created_at    INTEGER NOT NULL,
          FOREIGN KEY (tab_id) REFERENCES fb_scan_tabs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_scan_tab_data_tab ON fb_scan_tab_data(tab_id);

        CREATE TABLE IF NOT EXISTS fb_scan_tab_requests (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          tab_id          TEXT NOT NULL,
          request_payload TEXT DEFAULT '{}',
          response_preview TEXT DEFAULT '',
          status          TEXT NOT NULL DEFAULT 'error',
          error           TEXT DEFAULT '',
          items_count     INTEGER DEFAULT 0,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (tab_id) REFERENCES fb_scan_tabs(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_scan_tab_reqs_tab ON fb_scan_tab_requests(tab_id, created_at DESC);
      `);
      this.initialized = true;
      Logger.log('[ScanTab] Tables initialized');
    } catch (err: any) {
      Logger.error(`[ScanTab] Init error: ${err.message}`);
    }
  }

  // ─── Tab CRUD ─────────────────────────────────────────────────

  static saveTab(tab: ScanTabRecord): boolean {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      const existing = db.queryOne<any>('SELECT id FROM fb_scan_tabs WHERE id = ?', [tab.id]);
      if (existing) {
        // Tab đã tồn tại → UPDATE, không chạm updated_at (tránh xáo trộn thứ tự)
        db.run(`
          UPDATE fb_scan_tabs SET account_id = ?, name = ?, scan_type = ?, config = ?,
            status = ?, items_count = ?
          WHERE id = ?
        `, [tab.accountId, tab.name, tab.scanType, tab.config, tab.status, tab.itemsCount, tab.id]);
      } else {
        // Tab mới → INSERT với created_at và updated_at
        db.run(`
          INSERT INTO fb_scan_tabs (id, account_id, name, scan_type, config, status, items_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [tab.id, tab.accountId, tab.name, tab.scanType, tab.config, tab.status, tab.itemsCount, tab.createdAt, tab.updatedAt]);
      }
      return true;
    } catch (err: any) {
      Logger.error(`[ScanTab] SaveTab error: ${err.message}`);
      return false;
    }
  }

  static getTabs(accountId: string, status?: TabStatus, limit: number = 100, offset: number = 0): { tabs: ScanTabRecord[]; total: number } {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      let where = 'account_id = ?';
      const params: any[] = [accountId];
      if (status) { where += ' AND status = ?'; params.push(status); }
      params.push(limit, offset);

      const tabs = db.query<any>(
        `SELECT * FROM fb_scan_tabs WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        params
      );
      const countParams = [accountId];
      if (status) countParams.push(status);
      const totalRow = db.queryOne<any>(
        `SELECT COUNT(*) as total FROM fb_scan_tabs WHERE account_id = ?${status ? ' AND status = ?' : ''}`,
        countParams
      );
      return {
        tabs: (tabs || []).map(this.mapTab),
        total: totalRow?.total || 0,
      };
    } catch (err: any) {
      Logger.error(`[ScanTab] GetTabs error: ${err.message}`);
      return { tabs: [], total: 0 };
    }
  }

  static getTab(id: string): ScanTabRecord | null {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      const row = db.queryOne<any>('SELECT * FROM fb_scan_tabs WHERE id = ?', [id]);
      return row ? this.mapTab(row) : null;
    } catch (err: any) {
      Logger.error(`[ScanTab] GetTab error: ${err.message}`);
      return null;
    }
  }

  static updateTabStatus(id: string, status: TabStatus): boolean {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      db.run('UPDATE fb_scan_tabs SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id]);
      return true;
    } catch (err: any) {
      Logger.error(`[ScanTab] UpdateTabStatus error: ${err.message}`);
      return false;
    }
  }

  // Cập nhật updated_at khi người dùng kích hoạt tab (để đẩy lên đầu danh sách)
  static touchTab(id: string): boolean {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      db.run('UPDATE fb_scan_tabs SET updated_at = ? WHERE id = ?', [Date.now(), id]);
      return true;
    } catch (err: any) {
      Logger.error(`[ScanTab] TouchTab error: ${err.message}`);
      return false;
    }
  }

  static deleteTab(id: string): boolean {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      // Explicit delete từ child tables (safety net nếu foreign_keys chưa bật)
      db.run('DELETE FROM fb_scan_tab_requests WHERE tab_id = ?', [id]);
      db.run('DELETE FROM fb_scan_tab_data WHERE tab_id = ?', [id]);
      // Xóa cả lịch sử scan liên quan đến tab này
      try {
        const { default: FacebookScanLogService } = require('./FacebookScanLogService');
        FacebookScanLogService.deleteByTabId(id);
      } catch {}
      // Xóa tab (CASCADE sẽ xóa nốt nếu foreign_keys đã bật)
      db.run('DELETE FROM fb_scan_tabs WHERE id = ?', [id]);
      return true;
    } catch (err: any) {
      Logger.error(`[ScanTab] DeleteTab error: ${err.message}`);
      return false;
    }
  }

  // ─── Tab Data ─────────────────────────────────────────────────

  static saveTabData(tabId: string, items: any[], pageInfo: { endCursor: string | null; hasNextPage: boolean }): number | null {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      // Xóa data cũ của tab trước khi lưu mới (chỉ giữ bản snapshot mới nhất)
      db.run('DELETE FROM fb_scan_tab_data WHERE tab_id = ?', [tabId]);
      db.run(`
        INSERT INTO fb_scan_tab_data (tab_id, items, total_count, page_info, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [tabId, JSON.stringify(items), items.length, JSON.stringify(pageInfo), Date.now()]);
      const row = db.queryOne<any>('SELECT last_insert_rowid() as id');
      // Cập nhật items_count trong tab = số items hiện tại
      db.run('UPDATE fb_scan_tabs SET items_count = ?, updated_at = ? WHERE id = ?', [items.length, Date.now(), tabId]);
      return row?.id ?? null;
    } catch (err: any) {
      Logger.error(`[ScanTab] SaveTabData error: ${err.message}`);
      return null;
    }
  }

  static getTabData(tabId: string, limit: number = 1): any[] {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      return db.query<any>(
        'SELECT * FROM fb_scan_tab_data WHERE tab_id = ? ORDER BY created_at DESC LIMIT ?',
        [tabId, limit]
      );
    } catch (err: any) {
      Logger.error(`[ScanTab] GetTabData error: ${err.message}`);
      return [];
    }
  }

  // ─── Request Logs ─────────────────────────────────────────────

  static saveRequestLog(tabId: string, log: {
    requestPayload: string;
    responsePreview: string;
    status: 'success' | 'error';
    error?: string;
    itemsCount?: number;
  }): number | null {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      db.run(`
        INSERT INTO fb_scan_tab_requests (tab_id, request_payload, response_preview, status, error, items_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [tabId, log.requestPayload, log.responsePreview, log.status, log.error || '', log.itemsCount || 0, Date.now()]);
      const row = db.queryOne<any>('SELECT last_insert_rowid() as id');
      return row?.id ?? null;
    } catch (err: any) {
      Logger.error(`[ScanTab] SaveRequestLog error: ${err.message}`);
      return null;
    }
  }

  static getRequestLogs(tabId: string, limit: number = 50, offset: number = 0): { logs: any[]; total: number } {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      const rows = db.query<any>(
        'SELECT * FROM fb_scan_tab_requests WHERE tab_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [tabId, limit, offset]
      );
      const totalRow = db.queryOne<any>(
        'SELECT COUNT(*) as total FROM fb_scan_tab_requests WHERE tab_id = ?', [tabId]
      );
      return { logs: rows || [], total: totalRow?.total || 0 };
    } catch (err: any) {
      Logger.error(`[ScanTab] GetRequestLogs error: ${err.message}`);
      return { logs: [], total: 0 };
    }
  }

  // ─── Stats ────────────────────────────────────────────────────

  static getStats(accountId: string): { totalTabs: number; totalItems: number; successCount: number; errorCount: number; byType: Record<string, number>; topTabs: Array<{ id: string; name: string; itemsCount: number }> } {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      const totalTabs = db.queryOne<any>('SELECT COUNT(*) as total FROM fb_scan_tabs WHERE account_id = ?', [accountId])?.total || 0;
      // Lấy tổng items từ fb_scan_tab_data (dữ liệu thật) thay vì items_count có thể sai
      const totalItems = db.queryOne<any>(`
        SELECT COALESCE(SUM(td.total_count), 0) as total
        FROM fb_scan_tab_data td
        JOIN fb_scan_tabs t ON t.id = td.tab_id
        WHERE t.account_id = ? AND t.status != 'deleted'
      `, [accountId])?.total || 0;
      // Request counts từ fb_scan_tab_requests
      const successCount = db.queryOne<any>(`
        SELECT COUNT(*) as total FROM fb_scan_tab_requests r
        JOIN fb_scan_tabs t ON r.tab_id = t.id
        WHERE t.account_id = ? AND t.status != 'deleted' AND r.status = 'success'
      `, [accountId])?.total || 0;
      const errorCount = db.queryOne<any>(`
        SELECT COUNT(*) as total FROM fb_scan_tab_requests r
        JOIN fb_scan_tabs t ON r.tab_id = t.id
        WHERE t.account_id = ? AND t.status != 'deleted' AND r.status = 'error'
      `, [accountId])?.total || 0;
      const byTypeRows = db.query<any>('SELECT scan_type, COUNT(*) as cnt FROM fb_scan_tabs WHERE account_id = ? AND status != \'deleted\' GROUP BY scan_type', [accountId]);
      const byType: Record<string, number> = {};
      for (const r of byTypeRows || []) byType[r.scan_type] = r.cnt;
      // Top tabs theo total_count thật từ fb_scan_tab_data
      const topTabs = db.query<any>(`
        SELECT t.id, t.name, COALESCE(td.total_count, 0) as items_count
        FROM fb_scan_tabs t
        LEFT JOIN (
          SELECT tab_id, total_count FROM fb_scan_tab_data
          WHERE rowid IN (SELECT MAX(rowid) FROM fb_scan_tab_data GROUP BY tab_id)
        ) td ON td.tab_id = t.id
        WHERE t.account_id = ? AND t.status != 'deleted'
        ORDER BY items_count DESC LIMIT 5
      `, [accountId]) || [];
      return { totalTabs, totalItems, successCount, errorCount, byType, topTabs };
    } catch (err: any) {
      Logger.error(`[ScanTab] getStats error: ${err.message}`);
      return { totalTabs: 0, totalItems: 0, successCount: 0, errorCount: 0, byType: {}, topTabs: [] };
    }
  }

  // ─── Helper ───────────────────────────────────────────────────

  private static mapTab(r: any): ScanTabRecord {
    return {
      id: r.id,
      accountId: r.account_id,
      name: r.name,
      scanType: r.scan_type,
      config: r.config,
      status: r.status,
      itemsCount: r.items_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
