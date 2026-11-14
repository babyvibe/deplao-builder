/**
 * Text of Task management notifications (the in-app bell and Zalo messages): appointment / task due times, calendar time ranges, days off.
 * Shared by the ERP services in main (tasks, calendar, leave). Times use the clock of the machine running the service (local time).
 * Previously the text used `toLocaleString()` (e.g. "10/30/2026, 9:00:00 AM", depending on the machine) and employee IDs instead of names.
 */

import { tr } from '../i18n';

const pad2 = (value: number) => String(value).padStart(2, '0');

const dayOf = (d: Date) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
const timeOf = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** Due / appointment time: "09:00" (today), "09:00 27/10" (another day); all day: "Cả ngày hôm nay" / "Cả ngày 27/10". */
export function erpWhenText(at: number, allDay: boolean, now: number): string {
  const d = new Date(at);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (allDay) return sameDay ? tr('Cả ngày hôm nay') : tr('Cả ngày {{v1}}', { v1: dayOf(d) });
  return sameDay ? timeOf(d) : `${timeOf(d)} ${dayOf(d)}`;
}

/**
 * Calendar time range: "09:00 - 10:30" (today), "09:00 - 10:30 31/10", "09:00 27/10 - 10:00 28/10"; all-day over several
 * days: "Cả ngày 27/10 - 29/10". No end time (or an end before the start) → only the start time.
 */
export function erpTimeRangeText(startAt: number, endAt: number | null | undefined, allDay: boolean, now: number): string {
  const start = erpWhenText(startAt, allDay, now);
  if (!endAt || !Number.isFinite(endAt) || endAt <= startAt) return start;
  const startDate = new Date(startAt);
  if (allDay) {
    // An all-day event is stored until midnight the next day: step back 1 ms to get the correct last day
    const last = new Date(endAt - 1);
    return last.toDateString() === startDate.toDateString() ? start : tr('Cả ngày {{v1}} - {{v2}}', { v1: dayOf(startDate), v2: dayOf(last) });
  }
  const end = new Date(endAt);
  if (end.toDateString() === startDate.toDateString()) {
    const today = new Date(now).toDateString() === startDate.toDateString();
    return `${timeOf(startDate)} - ${timeOf(end)}${today ? '' : ` ${dayOf(startDate)}`}`;
  }
  // Across several days: always write both dates (avoid "09:00 - 10:00 28/10" being read as the same day, 28/10)
  return `${timeOf(startDate)} ${dayOf(startDate)} - ${timeOf(end)} ${dayOf(end)}`;
}

/** Date in the form "2026-10-30" → "30/10"; other strings are kept as they are. */
export function erpDayText(isoDate: string | null | undefined): string {
  const raw = String(isoDate ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return m ? `${m[3]}/${m[2]}` : raw;
}

/** "30/10" (one day) or "30/10 - 31/10". */
export function erpDayRangeText(startDate: string | null | undefined, endDate: string | null | undefined): string {
  const from = erpDayText(startDate);
  const to = erpDayText(endDate);
  return !to || to === from ? from : `${from} - ${to}`;
}

const LEAVE_KINDS: Record<string, string> = {
  annual: tr('nghỉ phép năm'),
  sick: tr('nghỉ ốm'),
  unpaid: tr('nghỉ không lương'),
};

/** Leave type in the sentence ("xin nghỉ ốm 2 ngày"): annual → "nghỉ phép năm"; other types → "nghỉ". */
export function erpLeaveKindText(leaveType: string | null | undefined): string {
  return LEAVE_KINDS[String(leaveType ?? '')] ?? tr('nghỉ');
}

/** "nghỉ ốm 2 ngày (30/10 - 31/10)"; if the day count is missing, drop the day-count part. */
export function erpLeaveSummaryText(leave: { leave_type?: string | null; days?: number | null; start_date?: string | null; end_date?: string | null }): string {
  const days = Number(leave.days);
  const range = erpDayRangeText(leave.start_date, leave.end_date);
  return [
    erpLeaveKindText(leave.leave_type),
    Number.isFinite(days) && days > 0 ? tr('{{days}} ngày', { days }) : '',
    range ? `(${range})` : '',
  ].filter(Boolean).join(' ');
}

/** Truncate long text (leave reason, notes) for notifications: at most `max` characters, add "…". */
export function erpClipText(text: string | null | undefined, max = 120): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
