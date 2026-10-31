/**
 * FacebookScanLogService.ts
 * Lưu lịch sử scan + full request payload để debug lỗi.
 * Tự quản lý table riêng, không phụ thuộc DatabaseService.
 */

import DatabaseService from '../../database/DatabaseService';
import Logger from '../../../utils/Logger';

export interface ScanLogEntry {
  id?: number;
  accountId: string;
  tabId: string;
  tabName: string;
  scanType: string;
  input: string;            // URL / keyword / batch input
  status: 'success' | 'error';
  itemsCount: number;
  error: string;
  requestPayload: string;   // JSON: params + variables đã gửi lên FB
  responsePreview: string;  // JSON: response gốc (200 ký tự đầu)
  requestHeaders?: string;  // JSON: request headers
  responseHeaders?: string; // JSON: response headers
  docId: string;
  threadCount: number;
  createdAt: number;
}

export class FacebookScanLogService {
  private static initialized = false;

  static init(): void {
    if (this.initialized) return;
    try {
      const db = DatabaseService.getInstance();

      // Tạo table - dùng run() thay vì exec() để tránh transaction conflict
      db.run(`
        CREATE TABLE IF NOT EXISTS fb_scan_history (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id        TEXT NOT NULL,
          tab_id            TEXT DEFAULT '',
          tab_name          TEXT DEFAULT '',
          scan_type         TEXT NOT NULL,
          input             TEXT NOT NULL,
          status            TEXT NOT NULL DEFAULT 'error',
          items_count       INTEGER DEFAULT 0,
          error             TEXT DEFAULT '',
          request_payload   TEXT DEFAULT '{}',
          response_preview  TEXT DEFAULT '',
          doc_id            TEXT DEFAULT '',
          thread_count      INTEGER DEFAULT 1,
          created_at        INTEGER NOT NULL
        )
      `);

      // Index riêng lẻ, không bao giờ trong transaction
      try { db.run('CREATE INDEX IF NOT EXISTS idx_scan_history_account ON fb_scan_history(account_id, created_at DESC)'); } catch {}
      try { db.run('CREATE INDEX IF NOT EXISTS idx_scan_history_tab ON fb_scan_history(tab_id, created_at DESC)'); } catch {}

      // Migration: thêm columns nếu chưa có (cho DB cũ)
      const tableInfo = db.query<any>('PRAGMA table_info(fb_scan_history)') || [];
      const existingColumns = new Set(tableInfo.map((r: any) => r.name));

      if (!existingColumns.has('tab_id')) {
        try { db.run("ALTER TABLE fb_scan_history ADD COLUMN tab_id TEXT DEFAULT ''"); } catch {}
      }
      if (!existingColumns.has('tab_name')) {
        try { db.run("ALTER TABLE fb_scan_history ADD COLUMN tab_name TEXT DEFAULT ''"); } catch {}
      }
      if (!existingColumns.has('request_payload')) {
        try { db.run("ALTER TABLE fb_scan_history ADD COLUMN request_payload TEXT DEFAULT '{}'"); } catch {}
      }
      if (!existingColumns.has('response_preview')) {
        try { db.run("ALTER TABLE fb_scan_history ADD COLUMN response_preview TEXT DEFAULT ''"); } catch {}
      }
      if (!existingColumns.has('doc_id')) {
        try { db.run("ALTER TABLE fb_scan_history ADD COLUMN doc_id TEXT DEFAULT ''"); } catch {}
      }
      if (!existingColumns.has('thread_count')) {
        try { db.run("ALTER TABLE fb_scan_history ADD COLUMN thread_count INTEGER DEFAULT 1"); } catch {}
      }
      if (!existingColumns.has('request_headers')) {
        try { db.run("ALTER TABLE fb_scan_history ADD COLUMN request_headers TEXT DEFAULT ''"); } catch {}
      }
      if (!existingColumns.has('response_headers')) {
        try { db.run("ALTER TABLE fb_scan_history ADD COLUMN response_headers TEXT DEFAULT ''"); } catch {}
      }

      this.initialized = true;
      Logger.log('[ScanLog] Table fb_scan_history initialized');
    } catch (err: any) {
      Logger.error(`[ScanLog] Init error: ${err.message}`);
    }
  }

  static save(entry: ScanLogEntry): number | null {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      db.run(`
        INSERT INTO fb_scan_history (account_id, tab_id, tab_name, scan_type, input, status, items_count, error, request_payload, response_preview, request_headers, response_headers, doc_id, thread_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        entry.accountId,
        entry.tabId,
        entry.tabName,
        entry.scanType,
        entry.input,
        entry.status,
        entry.itemsCount,
        entry.error,
        entry.requestPayload,
        entry.responsePreview,
        entry.requestHeaders || '',
        entry.responseHeaders || '',
        entry.docId,
        entry.threadCount,
        entry.createdAt || Date.now(),
      ]);
      // Lấy ID vừa insert
      const row = db.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
      return row?.id ?? null;
    } catch (err: any) {
      Logger.error(`[ScanLog] Save error: ${err.message}`);
      return null;
    }
  }

  static getList(accountId: string, tabId?: string, limit: number = 50, offset: number = 0): { logs: ScanLogEntry[]; total: number } {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      let where = 'account_id = ?';
      const params: any[] = [accountId];
      let countWhere = 'account_id = ?';
      const countParams: any[] = [accountId];
      if (tabId) {
        where += ' AND tab_id = ?';
        params.push(tabId);
        countWhere += ' AND tab_id = ?';
        countParams.push(tabId);
      }
      params.push(limit, offset);
      const rows = db.query<any>(
        `SELECT * FROM fb_scan_history WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        params
      );
      const totalRow = db.queryOne<any>(
        `SELECT COUNT(*) as total FROM fb_scan_history WHERE ${countWhere}`, countParams
      );
      const logs = (rows || []).map((r: any) => ({
        id: r.id,
        accountId: r.account_id,
        tabId: r.tab_id || '',
        tabName: r.tab_name || '',
        scanType: r.scan_type,
        input: r.input,
        status: r.status,
        itemsCount: r.items_count,
        error: r.error,
        requestPayload: r.request_payload,
        responsePreview: r.response_preview,
        requestHeaders: r.request_headers || '',
        responseHeaders: r.response_headers || '',
        docId: r.doc_id,
        threadCount: r.thread_count,
        createdAt: r.created_at,
      }));
      return { logs, total: totalRow?.total || 0 };
    } catch (err: any) {
      Logger.error(`[ScanLog] GetList error: ${err.message}`);
      return { logs: [], total: 0 };
    }
  }

  static deleteOld(olderThanDays: number = 7): void {
    try {
      this.init();
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      const db = DatabaseService.getInstance();
      db.run(`DELETE FROM fb_scan_history WHERE created_at < ?`, [cutoff]);
    } catch (err: any) {
      Logger.error(`[ScanLog] DeleteOld error: ${err.message}`);
    }
  }

  /** Xóa toàn bộ lịch sử scan của 1 tab */
  static deleteByTabId(tabId: string): void {
    try {
      this.init();
      const db = DatabaseService.getInstance();
      db.run('DELETE FROM fb_scan_history WHERE tab_id = ?', [tabId]);
    } catch (err: any) {
      Logger.error(`[ScanLog] DeleteByTabId error: ${err.message}`);
    }
  }
}
