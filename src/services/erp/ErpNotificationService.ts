import DatabaseService from '../DatabaseService';
import EventBroadcaster from '../EventBroadcaster';
import Logger from '../../utils/Logger';
import type { ErpNotification, ErpNotificationType } from '../../models/erp';

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

    // Optional Zalo bot side-channel.
    if (Array.isArray(payload?.channels) && payload.channels.includes('zalo')) {
      this.sendZaloBot(recipientId, `${title}\n${body}`).catch(() => { /* silent */ });
    }
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

  markRead(ids: number[]): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db().run(`UPDATE erp_notifications SET read = 1 WHERE id IN (${placeholders})`, ids);
  }

  markAllRead(recipientId: string): void {
    this.db().run(`UPDATE erp_notifications SET read = 1 WHERE recipient_id = ?`, [recipientId]);
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
   * Start due-soon (1m) + overdue (hourly) crons. Idempotent — safe to call twice.
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
              `Hạn: ${new Date(r.due_date).toLocaleString()}`,
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
        this.notify(
          r.employee_id, 'task_overdue',
          `${r.cnt} task quá hạn`,
          (r.titles || '').split('||').slice(0, 3).join(', '),
          'erp://tasks/overdue',
          { count: r.cnt, channels: ['toast', 'zalo'], dedupeKey }
        );
      }
    } catch (err: any) {
      Logger.warn(`[ErpNotificationService] overdue scan error: ${err.message}`);
    }
  }

  // ─── Zalo bot side-channel ────────────────────────────────────────────────

  /**
   * Send a plain-text message to the employee via a configured "notify bot"
   * Zalo account. Resolves the bot account id from app_settings key
   * `erp.notify_zalo_account_id` and the employee phone from
   * `erp_employee_profiles.phone`. Fail-silent.
   */
  async sendZaloBot(employeeId: string, text: string): Promise<void> {
    try {
      const botSetting = this.db().queryOne<any>(
        `SELECT value FROM app_settings WHERE key = 'erp.notify_zalo_account_id'`
      );
      const botAccountId = botSetting?.value;
      if (!botAccountId) return;

      const profile = this.db().queryOne<any>(
        `SELECT phone FROM erp_employee_profiles WHERE employee_id = ?`, [employeeId]
      );
      if (!profile?.phone) return;

      const botAccount = this.db().queryOne<any>(
        `SELECT * FROM accounts WHERE zalo_id = ?`, [botAccountId]
      );
      if (!botAccount) return;

      // Lazy import to avoid circular deps & keep notification service lightweight.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ZaloService = require('../ZaloService').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ZaloAccountManager = require('../ZaloAccountManager')?.default;
      const auth = ZaloAccountManager?.getInstance?.().getAuth?.(botAccountId);
      if (!auth) return;

      // Resolve user by phone, then send message.
      const svc = ZaloService.getInstance(auth);
      const found = await svc.findUser?.({ phoneNumber: profile.phone });
      const userId = found?.uid || found?.user_id;
      if (!userId) return;
      await svc.sendMessage({ threadId: userId, threadType: 0, message: { msg: text } });
    } catch (err: any) {
      Logger.warn(`[ErpNotificationService] sendZaloBot failed: ${err.message}`);
    }
  }
}

