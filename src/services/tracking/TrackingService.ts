/**
 * TrackingService - Gửi dữ liệu tracking page lên API deplaoapp.com.
 *
 * - Chỉ hoạt động khi build production (GitHub Actions / NODE_ENV=production).
 * - Cache local: mỗi ngày push 1 lần. Nếu có page mới tích hợp → track lại ngay trong ngày.
 * - Gửi pageId (UID Zalo / UID Facebook / telegram:<id>), machineId, lastTrackedAt lên Google Sheets.
 * - Không gửi các field nhạy cảm khác (name, phone,...).
 * - Tính năng phục vụ gia hạn tính năng premium, không thu thập thông tin cá nhân.
 *
 * Chỉ gửi trang đã tích hợp có UID thật (trackedPageIds): tài khoản đang dùng của các workspace trên máy này (không
 * đọc workspace nhân viên — đó là trang của Boss). Không có trang nào → không gửi gì. Trước 23/10/2026 máy chưa có
 * trang (hoặc chỉ có Telegram — kênh bị lọc sai) gửi "machine:<id>", và machineId sinh lại ở mỗi chỗ dùng nên một máy
 * mới tạo 2 dòng rác trong cùng ngày.
 *
 * API: POST https://deplaoapp.com/api/tracking/page
 * Rate limit: 10 req/giờ/IP - trả về 429 nếu vượt quá.
 */

import { IS_DEV_BUILD } from '../../configs/BuildConfig';
import DatabaseService from '../database/DatabaseService';
import WorkspaceManager from '../../utils/WorkspaceManager';
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
  trackedPageIds: string[];      // Danh sách pageId đã track lần gần nhất
}

interface TrackingApiResponse {
  success: boolean;
  message: string;
  upserted?: number;
  errors?: Array<{ pageId: string; error: string }>;
  retryAfterSec?: number;
}

/** Hàng bảng accounts (Zalo, Facebook, Telegram cá nhân / bot). */
export interface TrackedAccountRow {
  zalo_id?: string | null;
  channel?: string | null;
  is_active?: number | null;
}

/** Hàng bảng fb_accounts (Facebook). */
export interface TrackedFacebookRow {
  facebook_id?: string | null;
  status?: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const API_URL = 'https://deplaoapp.com/api/tracking/page';
const CACHE_FILENAME = 'tracking-cache.json';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 phút
const DEFAULT_DB_NAME = 'deplao-tool.db';

/** UID của nền tảng (Zalo, Facebook, Telegram) là dãy số. ID nội bộ (UUID), "9", rỗng… không phải trang tích hợp. */
const PLATFORM_UID = /^\d{5,20}$/;

/**
 * Trang gửi lên tracking: tài khoản đang dùng (accounts.is_active = 1) có UID thật — Zalo / Facebook: UID,
 * Telegram cá nhân + bot: "telegram:<id>"; thêm Facebook đang kết nối trong fb_accounts (bản cũ có thể thiếu hàng
 * accounts). Kênh lạ / ID không phải UID bị bỏ. Không có trang nào → [] (không gửi gì).
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
  /** Lần trước đã ghi "chưa có trang" — không ghi lại mỗi giờ. */
  private loggedNoPages = false;

  public static getInstance(): TrackingService {
    if (!TrackingService.instance) {
      TrackingService.instance = new TrackingService();
    }
    return TrackingService.instance;
  }

  /**
   * Khởi động tracking service.
   * Chỉ hoạt động trong production build.
   */
  public start(): void {
    // ── Guard: chỉ chạy trong production ────────────────────────────────
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

      // Chạy lần đầu sau 10s (đợi DB sẵn sàng)
      setTimeout(() => this.tick(), 10_000);

      // Lặp mỗi 60 phút
      this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    } catch (err: any) {
      Logger.error(`[TrackingService] ❌ Lỗi khởi động: ${err.message}`);
    }
  }

  /**
   * Dừng tracking service.
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
   * Trang đã tích hợp trên máy này: mọi workspace local (mặc định + workspace local khác), không gồm workspace nhân
   * viên (remote — bản sao trang của Boss, máy Boss tự gửi). Dùng chung cho so sánh với cache và payload gửi đi.
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
    } catch { /* WorkspaceManager chưa sẵn sàng → chỉ đọc DB đang mở */ }
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
   * So sánh 2 danh sách pageId (thứ tự đã sort).
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

      // Chưa tích hợp trang nào có UID → không gửi gì (không còn dòng "machine:<id>")
      if (currentIds.length === 0) {
        if (!this.loggedNoPages) Logger.log('[TrackingService] ℹ️ Chưa có trang tích hợp có UID - không gửi tracking');
        this.loggedNoPages = true;
        return;
      }
      this.loggedNoPages = false;

      // Nếu đã track hôm nay và danh sách page không đổi → bỏ qua
      if (this.cache?.lastTrackedDate === today) {
        const sameIds = this.areSameIds(this.cache.trackedPageIds, currentIds);
        if (sameIds) {
          return; // Đã track rồi, không có page mới
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

      // Cập nhật cache sau khi gửi thành công
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
      // Không crash app - thử lại vào lần tick sau (60 phút)
    }
  }

  /**
   * POST dữ liệu lên API tracking.
   */
  private async postTracking(payload: TrackingPayload[]): Promise<void> {
    const response = await axios.post<TrackingApiResponse>(
      API_URL,
      { pages: payload },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15_000, // 15 giây timeout
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
        // Migrate: cache cũ không có trackedPageIds → reset để track lại
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
   * machineId cố định cho máy này: lấy từ cache, chưa có thì tạo MỘT lần và lưu ngay (trước đây mỗi chỗ dùng tự sinh
   * UUID mới khi chưa có cache → một lần gửi mang machineId khác với cái được lưu).
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
   * Format date theo định dạng DD/MM/YYYY HH:mm (Google Sheets format).
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
