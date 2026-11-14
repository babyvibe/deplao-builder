/**
 * Task management (ERP) calendar reminders: selectable reminder times and their display text, shared by main (ErpCalendarService: advance
 * notifications) and the UI (choosing a time when creating / editing an event, the bell in the title bar, the popup at the exact time).
 * Advance reminder = a normal notification in the bell (reading it marks it as read) + the bell shakes in the title bar; exact-time reminder = a popup, like the
 * Zalo appointment reminder.
 */

/** Selectable reminder time (minutes before the appointment; 0 = at the appointment time). */
import { tr } from '../i18n';

export const ERP_REMINDER_CHOICES: readonly number[] = [0, 5, 15, 30, 60, 1440];

/** New events (Calendar page, quick add, from a message): remind 15 min before + at the exact time. */
export const DEFAULT_ERP_REMINDERS: readonly number[] = [15, 0];

/** 15 → "15 phút", 60 → "1 giờ", 90 → "1 giờ 30 phút", 1440 → "1 ngày". */
export function erpDurationText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m >= 1440 && m % 1440 === 0) return tr('{{v1}} ngày', { v1: m / 1440 });
  if (m >= 60) {
    const hours = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? tr('{{hours}} giờ {{rest}} phút', { hours, rest }) : tr('{{hours}} giờ', { hours });
  }
  return tr('{{m}} phút', { m });
}

/** Reminder time labels: 0 → "Đúng giờ" (at the time), 15 → "15 phút" (15 minutes). */
export function erpReminderChoiceLabel(minutes: number): string {
  return minutes === 0 ? tr('Đúng giờ') : erpDurationText(minutes);
}

/** Time left until the appointment (rounded up to the minute: 14 min 10 s → "15 phút nữa tới lịch hẹn"); at the time → "Đến giờ hẹn". */
export function erpReminderLeadText(msLeft: number): string {
  const minutes = Math.ceil(msLeft / 60_000);
  return minutes <= 0 ? tr('Đến giờ hẹn') : tr('{{v1}} nữa tới lịch hẹn', { v1: erpDurationText(minutes) });
}

/** The event's reminder times (duplicates removed, sorted from large to small) from the list saved in the DB / form. */
export function normalizeErpReminderMinutes(values: ReadonlyArray<number | { minutes_before: number } | null | undefined>): number[] {
  const out = new Set<number>();
  for (const value of values) {
    const raw = typeof value === 'number' ? value : value?.minutes_before;
    const minutes = Math.round(Number(raw));
    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 60 * 24 * 30) out.add(minutes);
  }
  return [...out].sort((a, b) => b - a);
}

/** "Nhắc: 15 phút trước, đúng giờ" (event details); no reminder → ''. */
export function erpRemindersSummary(minutes: readonly number[]): string {
  const list = normalizeErpReminderMinutes([...minutes]);
  if (!list.length) return '';
  return tr('Nhắc: {{v1}}', { v1: list.map(m => (m === 0 ? tr('đúng giờ') : tr('{{v1}} trước', { v1: erpDurationText(m) }))).join(', ') });
}
