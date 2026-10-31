import DatabaseService from '../database/DatabaseService';
import EventBroadcaster from '../event/EventBroadcaster';
import Logger from '../../utils/Logger';
import AccountSendQueue from '../workflow/AccountSendQueue';
import { BULK_RECIPIENT_GAP_SECONDS } from '../workflow/recipientPacing';
import type { ErpNotification, ErpNotificationType } from '../../models/erp';
import { erpWhenText } from '../../shared/erp/erpNotifyText';
import {
  ERP_ZALO_DAILY_CAP, ERP_ZALO_SETTING_KEYS, erpZaloMessageText, mergeErpZaloSettings, parseErpZaloSettings, zaloPhoneDigits,
  type ErpZaloNotifySettings, type ErpZaloNotifyStatus, type ErpZaloRecipient, type ErpZaloRecipientState, type ErpZaloSendLog,
} from '../../shared/erp/erpZaloNotify';
import { erpPersonName } from './erpPeople';

/** Người nhận tin Zalo, đọc DB lúc xếp hàng (lượt gửi chạy sau vài giây, lúc đó DB có thể đã đổi workspace). */
interface ZaloTarget {
  accountId: string;
  employeeId: string;
  name: string;
  /** SĐT đã chuẩn hoá (zaloPhoneDigits). */
  phone: string;
}

/** Kết quả gửi một tin Zalo: `error` = chữ cho người dùng khi không gửi được. */
export interface ErpZaloDelivery { ok: boolean; error?: string }

export default class ErpNotificationService {
  private static instance: ErpNotificationService;
  private dueSoonTimer: ReturnType<typeof setInterval> | null = null;
  private overdueTimer: ReturnType<typeof setInterval> | null = null;
  /** task_id → Set of yyyy-mm-dd markers already notified. */
  private dueSoonSeen: Map<string, Set<string>> = new Map();

  static getInstance(): ErpNotificationService {
    if (!this.instance) this.instance = new ErpNotificationService();
    return this.instance;
  }

  private db() { return DatabaseService.getInstance(); }

  notify(
    recipientId: string,
    type: ErpNotificationType,
    title: string,
    body: string = '',
    link: string = '',
    payload: Record<string, any> = {},
  ): ErpNotification {
    const now = Date.now();
    const newId = this.db().runInsert(
      `INSERT INTO erp_notifications (recipient_id, type, title, body, link, payload, read, created_at)
       VALUES (?,?,?,?,?,?,0,?)`,
      [recipientId, type, title, body, link, JSON.stringify(payload), now]
    );
    const row = this.db().queryOne<ErpNotification>(
      `SELECT * FROM erp_notifications WHERE id = ?`, [newId]
    )!;
    EventBroadcaster.emit('erp:event:notification', { notification: row });

    // Gửi kèm qua Zalo theo Cài đặt của Quản lý công việc (bật + loại thông báo đã chọn). payload.channels chỉ còn là
    // thông tin lưu kèm, không quyết định gửi Zalo nữa.
    this.queueZalo(recipientId, type, title, body);
    return row;
  }

  listInbox(recipientId: string, unreadOnly = false, opts: { limit?: number; offset?: number } = {}): ErpNotification[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const sql = unreadOnly
      ? `SELECT * FROM erp_notifications WHERE recipient_id = ? AND read = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?`
      : `SELECT * FROM erp_notifications WHERE recipient_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    return this.db().query<ErpNotification>(sql, [recipientId, limit, offset]);
  }

  /**
   * Đánh dấu đã đọc. `recipientId` → chỉ thông báo của người đó (id thông báo của người khác bị bỏ qua) — handler IPC
   * luôn truyền danh tính người gọi; trước đây theo id bất kỳ → nhân viên (REST) đánh dấu / xoá được hộp thư người khác.
   */
  markRead(ids: number[], recipientId?: string): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    if (recipientId === undefined) {
      this.db().run(`UPDATE erp_notifications SET read = 1 WHERE id IN (${placeholders})`, ids);
      return;
    }
    this.db().run(`UPDATE erp_notifications SET read = 1 WHERE id IN (${placeholders}) AND recipient_id = ?`, [...ids, recipientId]);
  }

  markAllRead(recipientId: string): void {
    this.db().run(`UPDATE erp_notifications SET read = 1 WHERE recipient_id = ?`, [recipientId]);
  }

  /** Xoá thông báo — `recipientId` như markRead: chỉ thông báo của người đó. */
  delete(ids: number[], recipientId?: string): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    if (recipientId === undefined) {
      this.db().run(`DELETE FROM erp_notifications WHERE id IN (${placeholders})`, ids);
      return;
    }
    this.db().run(`DELETE FROM erp_notifications WHERE id IN (${placeholders}) AND recipient_id = ?`, [...ids, recipientId]);
  }

  deleteAll(recipientId: string): void {
    this.db().run(`DELETE FROM erp_notifications WHERE recipient_id = ?`, [recipientId]);
  }

  getUnreadCount(recipientId: string): number {
    const row = this.db().queryOne<any>(
      `SELECT COUNT(*) as cnt FROM erp_notifications WHERE recipient_id = ? AND read = 0`,
      [recipientId]
    );
    return row?.cnt ?? 0;
  }

  // ─── Schedulers (Phase 2) ─────────────────────────────────────────────────

  /**
   * Start due-soon (1m) + overdue (hourly) crons. Idempotent - safe to call twice.
   */
  startSchedulers(): void {
    if (this.dueSoonTimer) clearInterval(this.dueSoonTimer);
    if (this.overdueTimer) clearInterval(this.overdueTimer);
    this.dueSoonTimer = setInterval(() => this._runDueSoonScan(), 60_000);
    this.overdueTimer = setInterval(() => this._runOverdueScan(), 60 * 60_000);
    // Run once shortly after start to pick up immediate tasks.
    setTimeout(() => { this._runDueSoonScan(); this._runOverdueScan(); }, 5_000);
    Logger.log('[ErpNotificationService] schedulers started (due-soon/60s, overdue/1h)');
  }

  stopSchedulers(): void {
    if (this.dueSoonTimer) { clearInterval(this.dueSoonTimer); this.dueSoonTimer = null; }
    if (this.overdueTimer) { clearInterval(this.overdueTimer); this.overdueTimer = null; }
  }

  private _todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  private _runDueSoonScan(): void {
    try {
      const now = Date.now();
      const soon = now + 60 * 60_000; // next 60m
      const rows = this.db().query<any>(
        `SELECT t.id, t.title, t.due_date,
                (SELECT GROUP_CONCAT(employee_id) FROM erp_task_assignees WHERE task_id = t.id) AS assignees
         FROM erp_tasks t
         WHERE t.archived = 0
           AND t.status NOT IN ('done','cancelled')
           AND t.due_date IS NOT NULL
           AND t.due_date BETWEEN ? AND ?`,
        [now, soon]
      );
      const todayKey = this._todayKey();
      for (const r of rows) {
        const seen = this.dueSoonSeen.get(r.id) ?? new Set<string>();
        if (seen.has(todayKey)) continue;
        const assignees: string[] = r.assignees ? r.assignees.split(',') : [];
        for (const empId of assignees) {
          try {
            this.notify(
              empId, 'task_due_soon',
              `Task sắp đến hạn: ${r.title}`,
              `Hạn: ${erpWhenText(Number(r.due_date), false, now)}`,
              `erp://task/${r.id}`,
              { taskId: r.id, channels: ['toast', 'zalo'] }
            );
          } catch { /* ignore */ }
        }
        seen.add(todayKey); this.dueSoonSeen.set(r.id, seen);
      }
    } catch (err: any) {
      Logger.warn(`[ErpNotificationService] due-soon scan error: ${err.message}`);
    }
  }

  private _runOverdueScan(): void {
    try {
      // Only fire once per day per assignee at 09:00–10:00 local
      const now = new Date();
      const hour = now.getHours();
      if (hour !== 9) return;
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const rows = this.db().query<any>(
        `SELECT GROUP_CONCAT(t.title, '||') AS titles, a.employee_id, COUNT(*) AS cnt
         FROM erp_tasks t
         JOIN erp_task_assignees a ON a.task_id = t.id
         WHERE t.archived = 0
           AND t.status NOT IN ('done','cancelled')
           AND t.due_date IS NOT NULL AND t.due_date < ?
         GROUP BY a.employee_id`,
        [todayStart.getTime()]
      );
      const todayKey = this._todayKey();
      for (const r of rows) {
        const dedupeKey = `overdue:${r.employee_id}:${todayKey}`;
        const exists = this.db().queryOne<any>(
          `SELECT 1 AS x FROM erp_notifications
           WHERE recipient_id = ? AND type = 'task_overdue'
             AND created_at >= ?`,
          [r.employee_id, todayStart.getTime()]
        );
        if (exists) continue;
        const titles = String(r.titles || '').split('||').filter(Boolean);
        const more = Number(r.cnt) > 3 ? ` và ${Number(r.cnt) - 3} task khác` : '';
        this.notify(
          r.employee_id, 'task_overdue',
          `${r.cnt} task quá hạn`,
          `${titles.slice(0, 3).join(', ')}${more}`,
          'erp://tasks/overdue',
          { count: r.cnt, channels: ['toast', 'zalo'], dedupeKey }
        );
      }
    } catch (err: any) {
      Logger.warn(`[ErpNotificationService] overdue scan error: ${err.message}`);
    }
  }

  // ─── Thông báo qua Zalo (Quản lý công việc → Cài đặt) ─────────────────────

  /** SĐT → uid Zalo đã tra, theo tài khoản gửi (`${tài khoản}|${số}`): uid, hoặc null = số không có Zalo (tra lại sau TTL) */
  private zaloUidCache: Map<string, { uid: string | null; at: number }> = new Map();
  private zaloUidInflight: Map<string, Promise<string | null>> = new Map();
  /** Tin gửi gần đây, mới nhất trước (trang Cài đặt hiện; chỉ trong phiên chạy này). */
  private zaloLog: ErpZaloSendLog[] = [];
  /** Số tin đang chờ tới lượt trong hàng gửi của tài khoản. */
  private zaloPending = 0;
  /** `${ngày}|${người nhận}` → số tin đã xếp gửi trong ngày (tối đa ERP_ZALO_DAILY_CAP). */
  private zaloDaily: Map<string, number> = new Map();

  getZaloSettings(): ErpZaloNotifySettings {
    const keys = Object.values(ERP_ZALO_SETTING_KEYS);
    const rows = this.db().query<{ key: string; value: string | null }>(
      `SELECT key, value FROM app_settings WHERE key IN (${keys.map(() => '?').join(',')})`, keys,
    ) || [];
    const value = (key: string) => rows.find(row => row.key === key)?.value ?? null;
    return parseErpZaloSettings({
      enabled: value(ERP_ZALO_SETTING_KEYS.enabled),
      accountId: value(ERP_ZALO_SETTING_KEYS.accountId),
      types: value(ERP_ZALO_SETTING_KEYS.types),
    });
  }

  /** Lưu cài đặt (chỉ trường có gửi). Đổi tài khoản → phải là tài khoản Zalo có trong app; bật mà chưa chọn tài khoản → lỗi. */
  setZaloSettings(patch: unknown): ErpZaloNotifySettings {
    const current = this.getZaloSettings();
    const next = mergeErpZaloSettings(current, patch);
    if (next.accountId && next.accountId !== current.accountId) {
      const problem = this.zaloAccountProblem(next.accountId);
      if (problem) throw new Error(problem);
    }
    if (next.enabled && !next.accountId) throw new Error('Chọn tài khoản Zalo gửi trước khi bật');
    const db = this.db();
    db.setSetting(ERP_ZALO_SETTING_KEYS.enabled, next.enabled ? '1' : '0');
    db.setSetting(ERP_ZALO_SETTING_KEYS.accountId, next.accountId);
    db.setSetting(ERP_ZALO_SETTING_KEYS.types, JSON.stringify(next.types));
    Logger.log(`[ErpNotificationService] Zalo: ${next.enabled ? 'bật' : 'tắt'}, tài khoản ${next.accountId || '-'}, ${next.types.length} loại`);
    return next;
  }

  /** Trạng thái cho trang Cài đặt: cài đặt, tài khoản gửi (đã kết nối chưa), người nhận, tin gần đây. */
  getZaloStatus(): ErpZaloNotifyStatus {
    const settings = this.getZaloSettings();
    return {
      settings,
      account: settings.accountId ? this.zaloAccountInfo(settings.accountId) : null,
      recipients: this.zaloRecipients(settings.accountId),
      recent: this.zaloLog.slice(),
      pending: this.zaloPending,
      gapSeconds: { min: BULK_RECIPIENT_GAP_SECONDS.min, max: BULK_RECIPIENT_GAP_SECONDS.max },
      dailyCap: ERP_ZALO_DAILY_CAP,
    };
  }

  /**
   * Gửi thử (trang Cài đặt): một tin tới nhân viên bằng tài khoản đang chọn, kể cả khi chưa bật. Đi chung hàng của tài
   * khoản; hàng dài quá ZALO_TEST_WAIT_MS → báo bận và bỏ lượt này (không gửi muộn).
   */
  async sendZaloTest(employeeId: string): Promise<ErpZaloDelivery> {
    const settings = this.getZaloSettings();
    if (!settings.accountId) return { ok: false, error: 'Chưa chọn tài khoản Zalo gửi' };
    const target = this.zaloTarget(employeeId, settings.accountId);
    if (typeof target === 'string') return { ok: false, error: target };
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const busy = new Promise<ErpZaloDelivery>((resolve) => {
      timer = setTimeout(() => {
        cancelled = true;
        resolve({ ok: false, error: 'Tài khoản Zalo đang bận gửi tin khác, thử lại sau ít phút' });
      }, ZALO_TEST_WAIT_MS);
    });
    const text = erpZaloMessageText('Tin thử từ Quản lý công việc', 'Thông báo công việc sẽ gửi vào Zalo này.');
    const result = await Promise.race([this.enqueueZalo(target, text, () => cancelled), busy])
      .finally(() => { if (timer) clearTimeout(timer); });
    this.logZalo({
      at: Date.now(), employeeId, name: target.name, title: 'Tin thử', ok: result.ok, test: true,
      ...(result.ok ? {} : { error: result.error }),
    });
    return result;
  }

  /**
   * Thông báo vừa tạo → tin Zalo cho người nhận nếu Cài đặt bật loại này. Đọc DB ngay (cài đặt, SĐT, tài khoản), gửi
   * sau qua hàng của tài khoản (AccountSendQueue, chung với trả lời tự động): cách nhau 5 - 10 giây, mỗi người tối đa
   * ERP_ZALO_DAILY_CAP tin / ngày. Không bao giờ ném (thông báo trong app vẫn có).
   */
  private queueZalo(recipientId: string, type: ErpNotificationType, title: string, body: string): void {
    try {
      if (isEmployeeMachine()) return; // máy nhân viên không có kết nối Zalo; Boss gửi
      const settings = this.getZaloSettings();
      if (!settings.enabled || !settings.accountId || !settings.types.includes(type)) return;
      const target = this.zaloTarget(recipientId, settings.accountId);
      if (typeof target === 'string') return; // chưa có SĐT… → trang Cài đặt hiện ở danh sách người nhận
      if (!this.takeZaloDailySlot(recipientId)) {
        this.logZalo({
          at: Date.now(), employeeId: recipientId, name: target.name, title, ok: false, skipped: true,
          error: `Đã đủ ${ERP_ZALO_DAILY_CAP} tin hôm nay, chỉ báo trong app`,
        });
        return;
      }
      void this.enqueueZalo(target, erpZaloMessageText(title, body)).then((result) => {
        this.logZalo({
          at: Date.now(), employeeId: recipientId, name: target.name, title, ok: result.ok,
          ...(result.ok ? {} : { error: result.error }),
        });
        if (!result.ok) Logger.warn(`[ErpNotificationService] Zalo → ${recipientId}: ${result.error}`);
      });
    } catch (err: any) {
      Logger.warn(`[ErpNotificationService] Zalo: ${err?.message || err}`);
    }
  }

  /** Lý do tài khoản không gửi được ('' = được). */
  private zaloAccountProblem(accountId: string): string {
    const account = this.db().queryOne<{ channel?: string | null }>(`SELECT channel FROM accounts WHERE zalo_id = ?`, [accountId]);
    if (!account) return 'Không tìm thấy tài khoản gửi trong app';
    if (account.channel && account.channel !== 'zalo') return 'Tài khoản gửi phải là tài khoản Zalo';
    return '';
  }

  /** Người nhận + tài khoản gửi dùng được → thông tin gửi; không thì lý do. */
  private zaloTarget(employeeId: string, accountId: string): ZaloTarget | string {
    const problem = this.zaloAccountProblem(accountId);
    if (problem) return problem;
    const profile = this.db().queryOne<{ phone?: string | null }>(
      `SELECT phone FROM erp_employee_profiles WHERE employee_id = ?`, [employeeId],
    );
    const phone = zaloPhoneDigits(profile?.phone);
    if (!phone) return 'Chưa có SĐT trong hồ sơ Nhân sự';
    return { accountId, employeeId, name: erpPersonName(employeeId), phone };
  }

  private takeZaloDailySlot(employeeId: string): boolean {
    const today = this._todayKey();
    const key = `${today}|${employeeId}`;
    const used = this.zaloDaily.get(key) ?? 0;
    if (used >= ERP_ZALO_DAILY_CAP) return false;
    if (!used) {
      // Ngày mới: bỏ số đếm của các ngày trước
      for (const k of [...this.zaloDaily.keys()]) if (!k.startsWith(`${today}|`)) this.zaloDaily.delete(k);
    }
    this.zaloDaily.set(key, used + 1);
    return true;
  }

  private enqueueZalo(target: ZaloTarget, text: string, isCancelled: () => boolean = () => false): Promise<ErpZaloDelivery> {
    this.zaloPending += 1;
    const { min, max } = BULK_RECIPIENT_GAP_SECONDS;
    return AccountSendQueue.getInstance()
      .enqueue<ErpZaloDelivery>(
        target.accountId,
        () => (isCancelled() ? Promise.resolve<ErpZaloDelivery>({ ok: false, error: 'Đã huỷ' }) : this.deliverZalo(target, text)),
        min * 1000,
        max * 1000,
      )
      .catch((err: any): ErpZaloDelivery => ({ ok: false, error: err?.message || String(err) }))
      .finally(() => { this.zaloPending -= 1; });
  }

  /**
   * Gửi một tin 1-1 bằng kết nối Zalo đang chạy của tài khoản (ConnectionManager, như chiến dịch CRM): tìm uid theo SĐT
   * → sendMessage. Không ném: lỗi trả về `{ ok: false, error }` (chữ cho người dùng).
   */
  private async deliverZalo(target: ZaloTarget, text: string): Promise<ErpZaloDelivery> {
    let api: any;
    try { api = zaloApiOf(target.accountId); } catch { api = undefined; }
    if (!api) return { ok: false, error: 'Tài khoản Zalo gửi chưa kết nối' };
    let uid: string | null;
    try {
      uid = await this.resolveZaloUid(api, target.accountId, target.phone);
    } catch (err: any) {
      return { ok: false, error: `Không tìm được SĐT trên Zalo: ${err?.message || err}` };
    }
    if (!uid) return { ok: false, error: 'SĐT chưa có Zalo hoặc đã tắt tìm qua SĐT' };
    if (uid === target.accountId) return { ok: false, error: 'SĐT này là của chính tài khoản gửi' };
    try {
      await withTimeout(api.sendMessage({ msg: text }, uid, 0 /* ThreadType.User */), ZALO_BOT_TIMEOUT_MS);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: zaloSendErrorText(err) };
    }
  }

  /**
   * SĐT (đã chuẩn hoá) → uid Zalo (findUser). Zalo giới hạn số lần tìm SĐT mỗi ngày nên nhớ kết quả: tìm được → nhớ cả
   * phiên, không có Zalo → thử lại sau ZALO_NOT_FOUND_TTL_MS; lỗi mạng không nhớ. Hai lần tra cùng số cùng lúc dùng chung.
   */
  private async resolveZaloUid(api: any, accountId: string, phone: string): Promise<string | null> {
    const key = `${accountId}|${phone}`;
    const cached = this.zaloUidCache.get(key);
    if (cached && (cached.uid || Date.now() - cached.at < ZALO_NOT_FOUND_TTL_MS)) return cached.uid;
    const pending = this.zaloUidInflight.get(key);
    if (pending) return pending;
    const lookup = (async () => {
      const found: any = await withTimeout(api.findUser(phone), ZALO_BOT_TIMEOUT_MS);
      const uid = found?.uid ? String(found.uid) : null;
      this.zaloUidCache.set(key, { uid, at: Date.now() });
      return uid;
    })().finally(() => { this.zaloUidInflight.delete(key); });
    this.zaloUidInflight.set(key, lookup);
    return lookup;
  }

  private zaloAccountInfo(accountId: string): NonNullable<ErpZaloNotifyStatus['account']> {
    const row = this.db().queryOne<{ full_name?: string | null; channel?: string | null }>(
      `SELECT full_name, channel FROM accounts WHERE zalo_id = ?`, [accountId],
    );
    if (!row) return { id: accountId, name: accountId, ready: false, missing: true };
    let ready = false;
    try { ready = !!zaloApiOf(accountId); } catch { ready = false; }
    return {
      id: accountId,
      name: String(row.full_name ?? '').trim() || accountId,
      ready,
      ...(row.channel && row.channel !== 'zalo' ? { notZalo: true } : {}),
    };
  }

  /** Nhân viên đang làm (+ Boss nếu đã có hồ sơ Nhân sự) với SĐT trong hồ sơ và trạng thái tìm Zalo. */
  private zaloRecipients(accountId: string): ErpZaloRecipient[] {
    let rows: Array<{ employee_id: string; display_name?: string | null; phone?: string | null }> = [];
    try {
      rows = this.db().query<{ employee_id: string; display_name?: string | null; phone?: string | null }>(
        `SELECT e.employee_id, e.display_name, p.phone
         FROM employees e LEFT JOIN erp_employee_profiles p ON p.employee_id = e.employee_id
         WHERE e.is_active = 1
         ORDER BY e.display_name COLLATE NOCASE`,
      ) || [];
    } catch { rows = []; }
    // Boss nhận thông báo khi là quản lý duyệt nghỉ, người tổ chức lịch…: có trong danh sách khi đã có hồ sơ Nhân sự
    const boss = this.db().queryOne<{ phone?: string | null }>(`SELECT phone FROM erp_employee_profiles WHERE employee_id = 'boss'`);
    const people = boss ? [{ employee_id: 'boss', display_name: 'Boss', phone: boss.phone }, ...rows] : rows;
    const now = Date.now();
    return people.map((person): ErpZaloRecipient => {
      const employeeId = String(person.employee_id);
      const phone = String(person.phone ?? '').trim();
      const digits = zaloPhoneDigits(phone);
      const cached = accountId && digits ? this.zaloUidCache.get(`${accountId}|${digits}`) : undefined;
      const state: ErpZaloRecipientState = !digits ? 'no_phone'
        : cached?.uid ? 'ok'
          : cached && now - cached.at < ZALO_NOT_FOUND_TTL_MS ? 'not_found'
            : 'unchecked';
      const last = this.zaloLog.find(entry => entry.employeeId === employeeId);
      return {
        employeeId,
        name: String(person.display_name ?? '').trim() || employeeId,
        phone,
        state,
        ...(last ? { last: { at: last.at, ok: last.ok, ...(last.error ? { error: last.error } : {}) } } : {}),
      };
    });
  }

  private logZalo(entry: ErpZaloSendLog): void {
    this.zaloLog.unshift(entry);
    if (this.zaloLog.length > ZALO_LOG_MAX) this.zaloLog.length = ZALO_LOG_MAX;
  }
}

/** Zalo không trả lời trong thời gian này → bỏ (như chiến dịch CRM), không để lời gọi treo mãi */
const ZALO_BOT_TIMEOUT_MS = 15_000;
/** Số điện thoại không có Zalo: tra lại sau 6 giờ (nhân viên có thể vừa tạo Zalo / sửa số) */
const ZALO_NOT_FOUND_TTL_MS = 6 * 60 * 60_000;
/** Gửi thử chờ tới lượt tối đa bấy nhiêu (hàng của tài khoản đang dài → báo bận). */
const ZALO_TEST_WAIT_MS = 60_000;
/** Số tin giữ trong "Gửi gần đây". */
const ZALO_LOG_MAX = 30;

/** Kết nối Zalo đang chạy của tài khoản. Lazy require: tránh vòng import, chỉ nạp zca-js khi thật sự cần. */
function zaloApiOf(accountId: string): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ConnectionManager = require('../../utils/connection/ConnectionManager').default;
  return ConnectionManager.getConnection(accountId)?.api;
}

/** Máy nhân viên (kết nối Boss): không có kết nối Zalo trực tiếp, Boss mới gửi. */
function isEmployeeMachine(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../../utils/app/AppModeManager').default.getInstance().getMode() === 'employee';
  } catch {
    return false;
  }
}

/** Lỗi Zalo khi gửi → chữ cho người dùng; lỗi kiểu "chỉ nhận tin từ bạn bè" thêm gợi ý kết bạn (mã như chiến dịch CRM). */
function zaloSendErrorText(err: any): string {
  const message = String(err?.message || err || 'Lỗi không rõ');
  const code = Number(err?.code ?? err?.errorCode ?? err?.error_code);
  const lower = message.toLowerCase();
  const strangerBlocked = [4, 9, 214, 216, 576, 579].includes(code)
    || ['chặn', 'block', 'stranger', 'bạn bè', 'not friend'].some(word => lower.includes(word));
  return strangerBlocked
    ? `${message} (có thể người nhận chỉ nhận tin từ bạn bè: kết bạn Zalo với tài khoản gửi)`
    : message;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Zalo không trả lời sau ${ms / 1000} giây`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}
