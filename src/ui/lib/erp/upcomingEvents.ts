/**
 * "Lịch sắp tới" (Upcoming events) in the notification bell (NotificationCenter → UpcomingEventsTab): your own ERP calendar events (organized by you
 * or invited, not declined) from now until the end of the next 7 days.
 *
 * This is only a list. Early and on-time alerts come from the "Nhắc trước" (remind before) setting of EACH event (main: ErpCalendarService, default 15 minutes +
 * on time). Each row shows the reminder setting of that event. There is no second shared reminder setting (it would duplicate and alert twice).
 */
import type { ErpCalendarEvent } from '../../../models/erp/CalendarEvent';
import { erpDurationText, erpRemindersSummary, normalizeErpReminderMinutes } from '../../../shared/erp/erpReminderText';
import { erpRelativeDay, isErpReminderForMe } from './erpReminder';
import { tr } from '../../../shared/i18n';

export const UPCOMING_DAYS = 7;
/** Events with no early reminder are highlighted as "sắp tới" (upcoming) when this many minutes remain. */
const SOON_WITHOUT_REMINDER_MINUTES = 15;

type UpcomingEvent = Pick<ErpCalendarEvent, 'id' | 'start_at' | 'end_at' | 'all_day' | 'organizer_id' | 'attendees'>;

const pad2 = (value: number) => String(value).padStart(2, '0');
const hhmm = (ts: number) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const endOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
};

/** Load range: from now until the end of the 7th day counting from today. */
export function upcomingRange(now: number): { from: number; to: number } {
  const end = new Date(now);
  end.setDate(end.getDate() + UPCOMING_DAYS);
  return { from: now, to: endOfDay(end.getTime()) };
}

/** Actual end time: an all-day event ends at the end of its day; no end time → the start time. */
export function eventEndAt(event: Pick<ErpCalendarEvent, 'start_at' | 'end_at' | 'all_day'>): number {
  const start = Number(event.start_at) || 0;
  if (event.all_day) return Math.max(endOfDay(start), Number(event.end_at) || 0);
  return Math.max(Number(event.end_at) || 0, start);
}

/** Your own events that have not ended yet (in progress or upcoming), sorted by start time. */
export function myUpcomingEvents<T extends UpcomingEvent>(events: readonly T[], myId: string, now: number): T[] {
  return events
    .filter(event => isErpReminderForMe(event, myId) && eventEndAt(event) >= now)
    .sort((a, b) => (Number(a.start_at) || 0) - (Number(b.start_at) || 0));
}

/** "09:00 - 10:30", "09:00", all-day event: "Cả ngày". */
export function upcomingTimeText(event: Pick<ErpCalendarEvent, 'start_at' | 'end_at' | 'all_day'>): string {
  if (event.all_day) return tr('Cả ngày');
  const start = Number(event.start_at) || 0;
  const end = Number(event.end_at) || 0;
  return end > start && startOfDay(end) === startOfDay(start) ? `${hhmm(start)} - ${hhmm(end)}` : hhmm(start);
}

/** Reminder setting of the event: "Nhắc: 15 phút trước, đúng giờ"; none → "Không nhắc". */
export function upcomingReminderText(event: Pick<ErpCalendarEvent, 'reminders'>): string {
  return erpRemindersSummary((event.reminders || []).map(reminder => Number(reminder?.minutes_before))) || tr('Không nhắc');
}

export type UpcomingTone = 'live' | 'soon' | 'later';

/**
 * Status on the right of each row: "Đang diễn ra" (in progress); 1 hour or less left: "còn 25 phút"; later today: "còn 3 giờ"; further away: nothing
 * is shown (the date is in the group header). The "sắp tới" color applies once the event reaches its earliest reminder time (no reminder: 15 minutes).
 */
export function upcomingStatus(event: Pick<ErpCalendarEvent, 'start_at' | 'end_at' | 'all_day' | 'reminders'>, now: number): { text: string; tone: UpcomingTone } {
  const start = Number(event.start_at) || 0;
  // All-day: the time column already says "Cả ngày", the group already shows the date
  if (event.all_day) return { text: '', tone: startOfDay(start) <= now ? 'live' : 'later' };
  if (start <= now) return { text: tr('Đang diễn ra'), tone: 'live' };
  const minutes = Math.ceil((start - now) / 60_000);
  const advance = normalizeErpReminderMinutes((event.reminders || []).map(reminder => Number(reminder?.minutes_before)))
    .filter(mark => mark > 0);
  const soon = minutes <= (advance[0] ?? SOON_WITHOUT_REMINDER_MINUTES);
  if (minutes <= 60) return { text: tr('còn {{v1}}', { v1: erpDurationText(minutes) }), tone: soon ? 'soon' : 'later' };
  if (startOfDay(start) === startOfDay(now)) return { text: tr('còn {{v1}} giờ', { v1: Math.round(minutes / 60) }), tone: soon ? 'soon' : 'later' };
  return { text: '', tone: soon ? 'soon' : 'later' };
}

/** Grouped by day: "Hôm nay", "Ngày mai", "Thứ 6, 07/11". Multi-day events in progress are placed under today. */
export function groupUpcomingByDay<T extends Pick<ErpCalendarEvent, 'start_at'>>(events: readonly T[], now: number): { label: string; items: T[] }[] {
  const groups: { label: string; day: number; items: T[] }[] = [];
  const today = startOfDay(now);
  for (const event of events) {
    const day = Math.max(startOfDay(Number(event.start_at) || 0), today);
    let group = groups.find(item => item.day === day);
    if (!group) {
      const text = erpRelativeDay(day, new Date(now));
      group = { label: text.charAt(0).toUpperCase() + text.slice(1), day, items: [] };
      groups.push(group);
    }
    group.items.push(event);
  }
  return groups.map(({ label, items }) => ({ label, items }));
}
