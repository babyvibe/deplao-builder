"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const DatabaseService_1 = __importDefault(require("../DatabaseService"));
const EventBroadcaster_1 = __importDefault(require("../EventBroadcaster"));
const Logger_1 = __importDefault(require("../../utils/Logger"));
class ErpNotificationService {
    constructor() {
        this.dueSoonTimer = null;
        this.overdueTimer = null;
        /** task_id → Set of yyyy-mm-dd markers already notified. */
        this.dueSoonSeen = new Map();
    }
    static getInstance() {
        if (!this.instance)
            this.instance = new ErpNotificationService();
        return this.instance;
    }
    db() { return DatabaseService_1.default.getInstance(); }
    notify(recipientId, type, title, body = '', link = '', payload = {}) {
        const now = Date.now();
        const newId = this.db().runInsert(`INSERT INTO erp_notifications (recipient_id, type, title, body, link, payload, read, created_at)
       VALUES (?,?,?,?,?,?,0,?)`, [recipientId, type, title, body, link, JSON.stringify(payload), now]);
        const row = this.db().queryOne(`SELECT * FROM erp_notifications WHERE id = ?`, [newId]);
        EventBroadcaster_1.default.emit('erp:event:notification', { notification: row });
        // Optional Zalo bot side-channel.
        if (Array.isArray(payload?.channels) && payload.channels.includes('zalo')) {
            this.sendZaloBot(recipientId, `${title}\n${body}`).catch(() => { });
        }
        return row;
    }
    listInbox(recipientId, unreadOnly = false, opts = {}) {
        const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
        const offset = Math.max(opts.offset ?? 0, 0);
        const sql = unreadOnly
            ? `SELECT * FROM erp_notifications WHERE recipient_id = ? AND read = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?`
            : `SELECT * FROM erp_notifications WHERE recipient_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        return this.db().query(sql, [recipientId, limit, offset]);
    }
    markRead(ids) {
        if (!ids.length)
            return;
        const placeholders = ids.map(() => '?').join(',');
        this.db().run(`UPDATE erp_notifications SET read = 1 WHERE id IN (${placeholders})`, ids);
    }
    markAllRead(recipientId) {
        this.db().run(`UPDATE erp_notifications SET read = 1 WHERE recipient_id = ?`, [recipientId]);
    }
    getUnreadCount(recipientId) {
        const row = this.db().queryOne(`SELECT COUNT(*) as cnt FROM erp_notifications WHERE recipient_id = ? AND read = 0`, [recipientId]);
        return row?.cnt ?? 0;
    }
    // ─── Schedulers (Phase 2) ─────────────────────────────────────────────────
    /**
     * Start due-soon (1m) + overdue (hourly) crons. Idempotent — safe to call twice.
     */
    startSchedulers() {
        if (this.dueSoonTimer)
            clearInterval(this.dueSoonTimer);
        if (this.overdueTimer)
            clearInterval(this.overdueTimer);
        this.dueSoonTimer = setInterval(() => this._runDueSoonScan(), 60000);
        this.overdueTimer = setInterval(() => this._runOverdueScan(), 60 * 60000);
        // Run once shortly after start to pick up immediate tasks.
        setTimeout(() => { this._runDueSoonScan(); this._runOverdueScan(); }, 5000);
        Logger_1.default.log('[ErpNotificationService] schedulers started (due-soon/60s, overdue/1h)');
    }
    stopSchedulers() {
        if (this.dueSoonTimer) {
            clearInterval(this.dueSoonTimer);
            this.dueSoonTimer = null;
        }
        if (this.overdueTimer) {
            clearInterval(this.overdueTimer);
            this.overdueTimer = null;
        }
    }
    _todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    _runDueSoonScan() {
        try {
            const now = Date.now();
            const soon = now + 60 * 60000; // next 60m
            const rows = this.db().query(`SELECT t.id, t.title, t.due_date,
                (SELECT GROUP_CONCAT(employee_id) FROM erp_task_assignees WHERE task_id = t.id) AS assignees
         FROM erp_tasks t
         WHERE t.archived = 0
           AND t.status NOT IN ('done','cancelled')
           AND t.due_date IS NOT NULL
           AND t.due_date BETWEEN ? AND ?`, [now, soon]);
            const todayKey = this._todayKey();
            for (const r of rows) {
                const seen = this.dueSoonSeen.get(r.id) ?? new Set();
                if (seen.has(todayKey))
                    continue;
                const assignees = r.assignees ? r.assignees.split(',') : [];
                for (const empId of assignees) {
                    try {
                        this.notify(empId, 'task_due_soon', `Task sắp đến hạn: ${r.title}`, `Hạn: ${new Date(r.due_date).toLocaleString()}`, `erp://task/${r.id}`, { taskId: r.id, channels: ['toast', 'zalo'] });
                    }
                    catch { /* ignore */ }
                }
                seen.add(todayKey);
                this.dueSoonSeen.set(r.id, seen);
            }
        }
        catch (err) {
            Logger_1.default.warn(`[ErpNotificationService] due-soon scan error: ${err.message}`);
        }
    }
    _runOverdueScan() {
        try {
            // Only fire once per day per assignee at 09:00–10:00 local
            const now = new Date();
            const hour = now.getHours();
            if (hour !== 9)
                return;
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const rows = this.db().query(`SELECT GROUP_CONCAT(t.title, '||') AS titles, a.employee_id, COUNT(*) AS cnt
         FROM erp_tasks t
         JOIN erp_task_assignees a ON a.task_id = t.id
         WHERE t.archived = 0
           AND t.status NOT IN ('done','cancelled')
           AND t.due_date IS NOT NULL AND t.due_date < ?
         GROUP BY a.employee_id`, [todayStart.getTime()]);
            const todayKey = this._todayKey();
            for (const r of rows) {
                const dedupeKey = `overdue:${r.employee_id}:${todayKey}`;
                const exists = this.db().queryOne(`SELECT 1 AS x FROM erp_notifications
           WHERE recipient_id = ? AND type = 'task_overdue'
             AND created_at >= ?`, [r.employee_id, todayStart.getTime()]);
                if (exists)
                    continue;
                this.notify(r.employee_id, 'task_overdue', `${r.cnt} task quá hạn`, (r.titles || '').split('||').slice(0, 3).join(', '), 'erp://tasks/overdue', { count: r.cnt, channels: ['toast', 'zalo'], dedupeKey });
            }
        }
        catch (err) {
            Logger_1.default.warn(`[ErpNotificationService] overdue scan error: ${err.message}`);
        }
    }
    // ─── Zalo bot side-channel ────────────────────────────────────────────────
    /**
     * Send a plain-text message to the employee via a configured "notify bot"
     * Zalo account. Resolves the bot account id from app_settings key
     * `erp.notify_zalo_account_id` and the employee phone from
     * `erp_employee_profiles.phone`. Fail-silent.
     */
    async sendZaloBot(employeeId, text) {
        try {
            const botSetting = this.db().queryOne(`SELECT value FROM app_settings WHERE key = 'erp.notify_zalo_account_id'`);
            const botAccountId = botSetting?.value;
            if (!botAccountId)
                return;
            const profile = this.db().queryOne(`SELECT phone FROM erp_employee_profiles WHERE employee_id = ?`, [employeeId]);
            if (!profile?.phone)
                return;
            const botAccount = this.db().queryOne(`SELECT * FROM accounts WHERE zalo_id = ?`, [botAccountId]);
            if (!botAccount)
                return;
            // Lazy import to avoid circular deps & keep notification service lightweight.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const ZaloService = require('../ZaloService').default;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const ZaloAccountManager = require('../ZaloAccountManager')?.default;
            const auth = ZaloAccountManager?.getInstance?.().getAuth?.(botAccountId);
            if (!auth)
                return;
            // Resolve user by phone, then send message.
            const svc = ZaloService.getInstance(auth);
            const found = await svc.findUser?.({ phoneNumber: profile.phone });
            const userId = found?.uid || found?.user_id;
            if (!userId)
                return;
            await svc.sendMessage({ threadId: userId, threadType: 0, message: { msg: text } });
        }
        catch (err) {
            Logger_1.default.warn(`[ErpNotificationService] sendZaloBot failed: ${err.message}`);
        }
    }
}
exports.default = ErpNotificationService;
//# sourceMappingURL=ErpNotificationService.js.map