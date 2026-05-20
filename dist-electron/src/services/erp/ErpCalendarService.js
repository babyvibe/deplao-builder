"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const uuid_1 = require("uuid");
const DatabaseService_1 = __importDefault(require("../DatabaseService"));
const EventBroadcaster_1 = __importDefault(require("../EventBroadcaster"));
const Logger_1 = __importDefault(require("../../utils/Logger"));
const ErpNotificationService_1 = __importDefault(require("./ErpNotificationService"));
class ErpCalendarService {
    constructor() {
        this.reminderTimers = new Map();
        /** Fallback cron interval that catches reminders missed by in-memory timers. */
        this.cronInterval = null;
    }
    static getInstance() {
        if (!this.instance)
            this.instance = new ErpCalendarService();
        return this.instance;
    }
    db() { return DatabaseService_1.default.getInstance(); }
    _normalizeEnd(startAt, endAt) {
        if (!endAt || !Number.isFinite(endAt))
            return startAt;
        return endAt < startAt ? startAt : endAt;
    }
    // ─── Events ────────────────────────────────────────────────────────────────
    listEvents(filter) {
        let sql = `
      SELECT DISTINCT e.* FROM erp_calendar_events e
      LEFT JOIN erp_event_attendees a ON a.event_id = e.id
      WHERE e.start_at <= ? AND COALESCE(e.end_at, e.start_at) >= ?
    `;
        const params = [filter.to, filter.from];
        if (filter.organizerId && filter.attendeeId) {
            sql += ' AND (e.organizer_id = ? OR a.employee_id = ?)';
            params.push(filter.organizerId, filter.attendeeId);
        }
        else if (filter.organizerId) {
            sql += ' AND e.organizer_id = ?';
            params.push(filter.organizerId);
        }
        else if (filter.attendeeId) {
            sql += ' AND a.employee_id = ?';
            params.push(filter.attendeeId);
        }
        sql += ' ORDER BY e.start_at ASC';
        // Defensive LIMIT — range-bounded but cap to protect against huge ranges.
        const limit = Math.min(Math.max(1, filter.limit ?? 1000), 2000);
        const offset = Math.max(0, filter.offset ?? 0);
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);
        const events = this.db().query(sql, params);
        if (!events.length)
            return events;
        // Fix N+1: batch-load reminders + attendees in 2 queries instead of 2N.
        const ids = events.map(e => e.id);
        const ph = ids.map(() => '?').join(',');
        const reminders = this.db().query(`SELECT * FROM erp_event_reminders WHERE event_id IN (${ph})`, ids);
        const attendees = this.db().query(`SELECT * FROM erp_event_attendees WHERE event_id IN (${ph})`, ids);
        const remBy = new Map();
        const attBy = new Map();
        for (const r of reminders) {
            const arr = remBy.get(r.event_id);
            if (arr)
                arr.push(r);
            else
                remBy.set(r.event_id, [r]);
        }
        for (const a of attendees) {
            const arr = attBy.get(a.event_id);
            if (arr)
                arr.push(a);
            else
                attBy.set(a.event_id, [a]);
        }
        return events.map(e => ({
            ...e,
            reminders: remBy.get(e.id) ?? [],
            attendees: attBy.get(e.id) ?? [],
        }));
    }
    listEventsForEmployee(employeeId, filter) {
        return this.listEvents({
            from: filter.from,
            to: filter.to,
            organizerId: employeeId,
            attendeeId: employeeId,
            limit: filter.limit,
            offset: filter.offset,
        });
    }
    getEvent(id) {
        const event = this.db().queryOne(`SELECT * FROM erp_calendar_events WHERE id = ?`, [id]);
        if (!event)
            return undefined;
        return {
            ...event,
            reminders: this.db().query(`SELECT * FROM erp_event_reminders WHERE event_id = ?`, [id]),
            attendees: this.db().query(`SELECT * FROM erp_event_attendees WHERE event_id = ?`, [id]),
        };
    }
    getEventForEmployee(id, employeeId) {
        const event = this.getEvent(id);
        return this.canAccessEvent(event, employeeId) ? event : undefined;
    }
    createEvent(input, organizerId) {
        const id = (0, uuid_1.v4)();
        const now = Date.now();
        const normalizedEndAt = this._normalizeEnd(input.start_at, input.end_at);
        this.db().transaction(() => {
            this.db().run(`INSERT INTO erp_calendar_events
          (id, title, description, type, start_at, end_at, all_day, location, color,
           organizer_id, linked_task_id, linked_contact_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
                id, input.title, input.description ?? '', input.type ?? 'meeting',
                input.start_at, normalizedEndAt, input.all_day ?? 0,
                input.location ?? '', input.color ?? '',
                organizerId, input.linked_task_id ?? null, input.linked_contact_id ?? null,
                now, now,
            ]);
            if (input.reminders?.length) {
                for (const r of input.reminders) {
                    this.db().run(`INSERT INTO erp_event_reminders (event_id, minutes_before, channel, triggered) VALUES (?,?,?,0)`, [id, r.minutes_before, r.channel]);
                }
            }
            if (input.attendees?.length) {
                for (const empId of input.attendees) {
                    if (!empId)
                        continue;
                    this.db().run(`INSERT OR IGNORE INTO erp_event_attendees (event_id, employee_id, status) VALUES (?,?, 'invited')`, [id, empId]);
                }
            }
        });
        const event = this.getEvent(id);
        this.scheduleEventReminders(event);
        // Notify attendees
        if (input.attendees?.length) {
            for (const empId of input.attendees) {
                if (empId && empId !== organizerId) {
                    try {
                        ErpNotificationService_1.default.getInstance().notify(empId, 'event_invited', `Mời tham dự: ${input.title}`, `${new Date(input.start_at).toLocaleString()}${normalizedEndAt > input.start_at ? ` → ${new Date(normalizedEndAt).toLocaleString()}` : ''}${input.location ? ` — ${input.location}` : ''}`, `erp://event/${id}`, { eventId: id, channels: ['toast', 'zalo'] });
                    }
                    catch (err) {
                        Logger_1.default.warn(`[ErpCalendarService] notify attendee: ${err.message}`);
                    }
                }
            }
        }
        EventBroadcaster_1.default.emit('erp:event:calendarEventCreated', { event, visibleEmployeeIds: this.getVisibleEmployeeIdsForEvent(event) });
        return event;
    }
    updateEvent(id, patch) {
        const now = Date.now();
        const existing = this.getEvent(id);
        if (!existing)
            throw new Error('Không tìm thấy sự kiện');
        const normalizedEndAt = patch.start_at !== undefined || patch.end_at !== undefined
            ? this._normalizeEnd(patch.start_at ?? existing.start_at, patch.end_at ?? existing.end_at)
            : undefined;
        const fields = [];
        const vals = [];
        const allowed = ['title', 'description', 'type', 'start_at', 'end_at', 'all_day', 'location', 'color'];
        for (const key of allowed) {
            if (key === 'end_at' && normalizedEndAt !== undefined) {
                fields.push('end_at = ?');
                vals.push(normalizedEndAt);
                continue;
            }
            if (patch[key] !== undefined && key !== 'end_at') {
                fields.push(`${key} = ?`);
                vals.push(patch[key]);
            }
        }
        if (fields.length) {
            fields.push('updated_at = ?');
            vals.push(now);
            vals.push(id);
            this.db().run(`UPDATE erp_calendar_events SET ${fields.join(', ')} WHERE id = ?`, vals);
        }
        const event = this.getEvent(id);
        this.scheduleEventReminders(event);
        EventBroadcaster_1.default.emit('erp:event:calendarEventUpdated', { eventId: id, event, visibleEmployeeIds: this.getVisibleEmployeeIdsForEvent(event) });
        return event;
    }
    updateEventForEmployee(id, patch, employeeId) {
        const existing = this.getEvent(id);
        if (!existing || !this.isEventOrganizer(existing, employeeId))
            throw new Error('Bạn không có quyền sửa sự kiện này');
        return this.updateEvent(id, patch);
    }
    deleteEvent(id) {
        const existing = this.getEvent(id);
        const visibleEmployeeIds = this.getVisibleEmployeeIdsForEvent(existing);
        this.cancelReminders(id);
        this.db().transaction(() => {
            this.db().run(`DELETE FROM erp_event_reminders WHERE event_id = ?`, [id]);
            this.db().run(`DELETE FROM erp_event_attendees WHERE event_id = ?`, [id]);
            this.db().run(`DELETE FROM erp_calendar_events WHERE id = ?`, [id]);
        });
        EventBroadcaster_1.default.emit('erp:event:calendarEventDeleted', { eventId: id, visibleEmployeeIds });
    }
    deleteEventForEmployee(id, employeeId) {
        const existing = this.getEvent(id);
        if (!existing || !this.isEventOrganizer(existing, employeeId))
            throw new Error('Bạn không có quyền xóa sự kiện này');
        this.deleteEvent(id);
    }
    checkConflict(employeeIds, start_at, end_at, excludeEventId) {
        const results = [];
        for (const eid of employeeIds) {
            if (!eid)
                continue;
            const rows = this.db().query(`
        SELECT DISTINCT e.id, e.title FROM erp_calendar_events e
        LEFT JOIN erp_event_attendees a ON a.event_id = e.id
        WHERE (e.organizer_id = ? OR a.employee_id = ?)
          AND e.start_at < ? AND e.end_at > ?
          ${excludeEventId ? 'AND e.id <> ?' : ''}
      `, excludeEventId
                ? [eid, eid, end_at, start_at, excludeEventId]
                : [eid, eid, end_at, start_at]);
            for (const c of rows) {
                results.push({ employee_id: eid, conflicting_event_id: c.id, conflicting_event_title: c.title });
            }
        }
        return results;
    }
    /** Update attendee response status (accept/decline/tentative). */
    respondToEvent(eventId, employeeId, status) {
        const event = this.getEvent(eventId);
        if (!this.canAccessEvent(event, employeeId)) {
            throw new Error('Bạn không có quyền phản hồi sự kiện này');
        }
        const now = Date.now();
        this.db().run(`INSERT INTO erp_event_attendees (event_id, employee_id, status) VALUES (?,?,?)
       ON CONFLICT(event_id, employee_id) DO UPDATE SET status = excluded.status`, [eventId, employeeId, status]);
        this.db().run(`UPDATE erp_calendar_events SET updated_at = ? WHERE id = ?`, [now, eventId]);
        const updatedEvent = this.getEvent(eventId);
        EventBroadcaster_1.default.emit('erp:event:calendarEventUpdated', {
            eventId,
            event: updatedEvent,
            visibleEmployeeIds: this.getVisibleEmployeeIdsForEvent(updatedEvent),
        });
    }
    // ─── Reminders ─────────────────────────────────────────────────────────────
    scheduleEventReminders(event) {
        if (!event.reminders?.length)
            return;
        this.cancelReminders(event.id);
        const now = Date.now();
        for (const r of event.reminders) {
            if (r.triggered)
                continue;
            const fireAt = event.start_at - r.minutes_before * 60000;
            const delay = fireAt - now;
            if (delay <= 0)
                continue;
            const timer = setTimeout(() => this._fireReminder(r.id, event, r.minutes_before), delay);
            this.reminderTimers.set(r.id, timer);
        }
    }
    cancelReminders(eventId) {
        const reminders = this.db().query(`SELECT id FROM erp_event_reminders WHERE event_id = ?`, [eventId]);
        for (const r of reminders) {
            const timer = this.reminderTimers.get(r.id);
            if (timer) {
                clearTimeout(timer);
                this.reminderTimers.delete(r.id);
            }
        }
    }
    _fireReminder(reminderId, event, minutesBefore) {
        try {
            // Atomic: only fire if still un-triggered (survives app restart race).
            const changed = this.db().query(`UPDATE erp_event_reminders SET triggered = 1 WHERE id = ? AND triggered = 0 RETURNING id`, [reminderId]);
            if (!changed.length)
                return; // already fired
            EventBroadcaster_1.default.emit('erp:event:reminder', {
                event,
                title: `Nhắc nhở: ${event.title}`,
                body: `Sự kiện bắt đầu sau ${minutesBefore} phút`,
            });
        }
        catch (err) {
            Logger_1.default.error(`[ErpCalendarService] Reminder trigger error: ${err.message}`);
        }
        this.reminderTimers.delete(reminderId);
    }
    /** Load and schedule all upcoming reminders on app start + kick off safety-net cron. */
    initSchedulers() {
        const now = Date.now();
        const lookahead = now + 24 * 60 * 60000; // 24h lookahead
        const events = this.listEvents({ from: now, to: lookahead });
        for (const event of events) {
            this.scheduleEventReminders(event);
        }
        Logger_1.default.log(`[ErpCalendarService] Scheduled reminders for ${events.length} upcoming events`);
        // Safety-net cron: every 60s, fire any reminder whose fireAt already passed but
        // whose timer was never set (e.g. app was offline, or event is >24h away but
        // was rescheduled during this uptime into lookahead window).
        if (this.cronInterval)
            clearInterval(this.cronInterval);
        this.cronInterval = setInterval(() => this._cronTick(), 60000);
    }
    _cronTick() {
        try {
            const now = Date.now();
            // Reminders whose fire time has passed, not yet triggered.
            const due = this.db().query(`
        SELECT r.id as reminder_id, r.event_id, r.minutes_before, e.*
        FROM erp_event_reminders r
        JOIN erp_calendar_events e ON e.id = r.event_id
        WHERE r.triggered = 0 AND (e.start_at - r.minutes_before * 60000) <= ?
      `, [now]);
            for (const row of due) {
                const evt = {
                    ...row,
                    id: row.event_id,
                    reminders: [],
                };
                this._fireReminder(row.reminder_id, evt, row.minutes_before);
            }
        }
        catch (err) {
            Logger_1.default.warn(`[ErpCalendarService] cron tick error: ${err.message}`);
        }
    }
    /** Create a linked calendar event when task due_date is set */
    syncTaskToCalendar(taskId, title, dueDate, organizerId) {
        const existing = this.db().queryOne(`SELECT id FROM erp_calendar_events WHERE linked_task_id = ?`, [taskId]);
        if (existing) {
            this.updateEvent(existing.id, { title: `📋 ${title}`, start_at: dueDate, end_at: dueDate + 3600000 });
        }
        else {
            this.createEvent({
                title: `📋 ${title}`,
                type: 'task',
                start_at: dueDate,
                end_at: dueDate + 3600000,
                linked_task_id: taskId,
            }, organizerId);
        }
    }
    isEventOrganizer(event, employeeId) {
        return !!event && event.organizer_id === employeeId;
    }
    canAccessEvent(event, employeeId) {
        if (!event)
            return false;
        if (this.isEventOrganizer(event, employeeId))
            return true;
        return !!event.attendees?.some(attendee => attendee.employee_id === employeeId);
    }
    getVisibleEmployeeIdsForEvent(event) {
        if (!event)
            return [];
        return Array.from(new Set([
            event.organizer_id,
            ...(event.attendees || []).map(attendee => attendee.employee_id),
        ].filter(Boolean)));
    }
}
exports.default = ErpCalendarService;
//# sourceMappingURL=ErpCalendarService.js.map