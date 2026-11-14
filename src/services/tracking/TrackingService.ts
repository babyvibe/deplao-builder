/**
 * TrackingService: sends page tracking data to the deplaoapp.com API.
 *
 * - Only runs in the production build (GitHub Actions / NODE_ENV=production).
 * - Local cache: pushes once per day. If a new integrated page appears → track again the same day.
 * - Sends pageId (Zalo UID / Facebook UID / telegram:<id>), machineId, lastTrackedAt to Google Sheets.
 * - Does not send other sensitive fields (name, phone, ...).
 * - The purpose is to support renewing premium features; no personal information is collected.
 *
 * Only sends integrated pages with a real UID (trackedPageIds): the accounts in use across the workspaces on this machine (does not
 * read employee workspaces, those pages belong to the Boss). No page → nothing is sent. Before 23/10/2026 the machine had no
 * page (or only Telegram, which was filtered wrongly) and sent "machine:<id>", and the machineId was regenerated at each use, so a new machine
 * created 2 junk rows on the same day.
 *
 * API: POST https://deplaoapp.com/api/tracking/page
 * Rate limit: 10 req/hour/IP; returns 429 when exceeded.
 */

import { IS_DEV_BUILD } from '../../configs/app/BuildConfig';
import DatabaseService from '../database/DatabaseService';
import WorkspaceManager from '../../utils/app/WorkspaceManager';
import Logger from '../../utils/Logger';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TrackingPayload {
  pageId: string;
  machineId: string;
  lastTrackedAt: string;
}

interface TrackingCache {
  machineId: string;
  lastTrackedDate: string;       // ISO date string "YYYY-MM-DD"
  lastTrackedAt: string;         // ISO datetime string
  trackedPageIds: string[];      // List of pageIds tracked most recently
}

interface TrackingApiResponse {
  success: boolean;
  message: string;
  upserted?: number;
  errors?: Array<{ pageId: string; error: string }>;
  retryAfterSec?: number;
}

/** A row of the accounts table (Zalo, Facebook, personal Telegram / bot). */
export interface TrackedAccountRow {
  zalo_id?: string | null;
  channel?: string | null;
  is_active?: number | null;
}

/** A row of the fb_accounts table (Facebook). */
export interface TrackedFacebookRow {
  facebook_id?: string | null;
  status?: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const API_URL = 'https://deplaoapp.com/api/tracking/page';
const CACHE_FILENAME = 'tracking-cache.json';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_DB_NAME = 'deplao-tool.db';

/** Platform UIDs (Zalo, Facebook, Telegram) are numeric. The internal ID (UUID), "9", empty… are not integrated pages. */
const PLATFORM_UID = /^\d{5,20}$/;

/**
 * Pages sent to tracking: the accounts in use (accounts.is_active = 1) with a real UID: Zalo / Facebook: the UID;
 * personal Telegram + bot: "telegram:<id>"; plus the connected Facebook accounts in fb_accounts (an older version may lack the accounts
 * row). Unknown channels / IDs that are not UIDs are dropped. No page → [] (nothing is sent).
 */
export function trackedPageIds(accounts: TrackedAccountRow[], facebookAccounts: TrackedFacebookRow[]): string[] {
  const ids = new Set<string>();
  for (const acc of accounts) {
    if (acc.is_active !== undefined && acc.is_active !== null && Number(acc.is_active) !== 1) continue;
    const uid = String(acc.zalo_id ?? '').trim();
    if (!PLATFORM_UID.test(uid)) continue;
    const channel = String(acc.channel || 'zalo');
    if (channel === 'zalo' || channel === 'facebook') ids.add(uid);
    else if (channel === 'telegram_user' || channel === 'telegram_bot' || channel === 'telegram') ids.add(`telegram:${uid}`);
  }
  for (const fb of facebookAccounts) {
    const uid = String(fb.facebook_id ?? '').trim();
    if (PLATFORM_UID.test(uid) && fb.status !== 'disconnected') ids.add(uid);
  }
  return Array.from(ids).sort();
}

// ─── TrackingService ────────────────────────────────────────────────────────

class TrackingService {
  private static instance: TrackingService;
  private cache: TrackingCache | null = null;
  private cachePath = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Last time "chưa có trang" (no page) was recorded: do not record it again every hour. */
  private loggedNoPages = false;

  public static getInstance(): TrackingService {
    if (!TrackingService.instance) {
      TrackingService.instance = new TrackingService();
    }
    return TrackingService.instance;
  }

  /**
   * Start the tracking service.
   * Only works in the production build.
   */
  public start(): void {
    // ── Guard: only runs in production ────────────────────────────────
    if (IS_DEV_BUILD) {
      Logger.log('[TrackingService] 🔇 Bỏ qua - đang chạy ở môi trường development');
      return;
    }

    if (this.running) {
      Logger.log('[TrackingService] ⚠️ Đã khởi động rồi, bỏ qua');
      return;
    }

    this.running = true;

    try {
      this.cachePath = path.join(app.getPath('userData'), CACHE_FILENAME);
      this.loadCache();
      this.ensureMachineId();

      Logger.log(`[TrackingService] ✅ Khởi động - machineId=${this.cache?.machineId?.slice(0, 8)}... lastTracked=${this.cache?.lastTrackedDate || 'never'}`);

      // First run 10 s after start (wait for the DB to be ready)
      setTimeout(() => this.tick(), 10_000);

      // Repeat every 60 minutes
      this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    } catch (err: any) {
      Logger.error(`[TrackingService] ❌ Lỗi khởi động: ${err.message}`);
    }
  }

  /**
   * Stop the tracking service.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    Logger.log('[TrackingService] 🔇 Đã dừng');
  }

  // ── Core logic ──────────────────────────────────────────────────────────

  /**
   * Pages integrated on this machine: every local workspace (the default one + other local workspaces), excluding employee
   * workspaces (remote: a copy of the Boss's pages, which the Boss's machine sends itself). Shared for comparing with the cache and the outgoing payload.
   */
  private collectCurrentPageIds(): string[] {
    const db = DatabaseService.getInstance();
    const read = () => trackedPageIds(db.getAccounts() || [], db.getFBAccounts() || []);
    let localDbPaths: string[] = [];
    try {
      const wm = WorkspaceManager.getInstance();
      localDbPaths = wm.listWorkspaces()
        .filter((ws) => ws.type === 'local')
        .map((ws) => wm.resolveDbPath(ws.dbPath || DEFAULT_DB_NAME));
    } catch { /* WorkspaceManager not ready → only read the DB that is open */ }
    if (localDbPaths.length === 0) return read();

    const ids = new Set<string>();
    for (const dbPath of localDbPaths) {
      try {
        for (const id of db.withDbPath(dbPath, read)) ids.add(id);
      } catch (err: any) {
        Logger.warn(`[TrackingService] ⚠️ Không đọc được tài khoản của một workspace: ${err.message}`);
      }
    }
    return Array.from(ids).sort();
  }

  /**
   * Compare two pageId lists (sorted order).
   */
  private areSameIds(a: string[] | undefined, b: string[]): boolean {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private async tick(): Promise<void> {
    try {
      const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
      const currentIds = this.collectCurrentPageIds();

      // No integrated page has a UID → send nothing (no more "machine:<id>" rows)
      if (currentIds.length === 0) {
        if (!this.loggedNoPages) Logger.log('[TrackingService] ℹ️ Chưa có trang tích hợp có UID - không gửi tracking');
        this.loggedNoPages = true;
        return;
      }
      this.loggedNoPages = false;

      // If already tracked today and the page list has not changed → skip
      if (this.cache?.lastTrackedDate === today) {
        const sameIds = this.areSameIds(this.cache.trackedPageIds, currentIds);
        if (sameIds) {
          return; // Already tracked, no new page
        }
        Logger.log('[TrackingService] 🔄 Phát hiện page mới tích hợp - track lại ngay');
      } else {
        Logger.log('[TrackingService] 📡 Bắt đầu gửi tracking hôm nay...');
      }

      const machineId = this.ensureMachineId();
      const lastTrackedAt = this.formatDate(new Date());
      const payload: TrackingPayload[] = currentIds.map((pageId) => ({ pageId, machineId, lastTrackedAt }));
      Logger.log(`[TrackingService] 📤 Gửi ${payload.length} page(s) lên API...`);
      await this.postTracking(payload);

      // Update the cache after a successful send
      this.cache = {
        machineId,
        lastTrackedDate: today,
        lastTrackedAt: new Date().toISOString(),
        trackedPageIds: currentIds,
      };
      this.saveCache();

      Logger.log('[TrackingService] ✅ Tracking đã gửi thành công');
    } catch (err: any) {
      Logger.warn(`[TrackingService] ⚠️ Gửi tracking thất bại: ${err.message}`);
      // Do not crash the app: retry on the next tick (60 minutes)
    }
  }

  /**
   * POST data to the tracking API.
   */
  private async postTracking(payload: TrackingPayload[]): Promise<void> {
    const response = await axios.post<TrackingApiResponse>(
      API_URL,
      { pages: payload },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15_000, // 15-second timeout
      },
    );

    const data = response.data;

    if (data.success) {
      Logger.log(`[TrackingService] ✅ API: ${data.message} (upserted=${data.upserted})`);
    } else if (data.errors && data.errors.length > 0) {
      Logger.warn(`[TrackingService] ⚠️ API partial error: ${data.message}`);
      for (const err of data.errors) {
        Logger.warn(`[TrackingService]   → pageId=${err.pageId}: ${err.error}`);
      }
    } else {
      Logger.warn(`[TrackingService] ⚠️ API trả về lỗi: ${data.message}`);
    }
  }

  // ── Cache management ────────────────────────────────────────────────────

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = fs.readFileSync(this.cachePath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Migrate: an old cache without trackedPageIds → reset so it tracks again
        if (!Array.isArray(parsed.trackedPageIds)) {
          parsed.trackedPageIds = [];
        }
        this.cache = parsed as TrackingCache;
        Logger.log(`[TrackingService] 📂 Đã load cache: lastTrackedDate=${this.cache.lastTrackedDate}, trackedPages=${this.cache.trackedPageIds.length}`);
      }
    } catch (err: any) {
      Logger.warn(`[TrackingService] ⚠️ Lỗi đọc cache: ${err.message} - sẽ tạo mới`);
    }
  }

  private saveCache(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (err: any) {
      Logger.warn(`[TrackingService] ⚠️ Lỗi ghi cache: ${err.message}`);
    }
  }

  /**
   * Fixed machineId for this machine: taken from the cache, or created ONCE and saved at once when there is none (previously each use generated its own
   * UUID when there was no cache, so one send carried a different machineId from the one saved).
   */
  private ensureMachineId(): string {
    if (this.cache?.machineId) return this.cache.machineId;
    const id = uuidv4();
    this.cache = { lastTrackedDate: '', lastTrackedAt: '', trackedPageIds: [], ...(this.cache || {}), machineId: id };
    Logger.log(`[TrackingService] 🆔 Đã tạo machineId mới: ${id.slice(0, 8)}...`);
    if (this.cachePath) this.saveCache();
    return id;
  }

  /**
   * Format a date as DD/MM/YYYY HH:mm (Google Sheets format).
   */
  private formatDate(date: Date): string {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  }
}

export default TrackingService;
