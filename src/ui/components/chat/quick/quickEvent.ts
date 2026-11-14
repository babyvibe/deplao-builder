/**
 * Quick "Add appointment" (ERP calendar): the form's default values and the data sent to createEvent.
 * Date / time use the machine's local time (input type="date" / "time"). Pure: tested in src/__tests__/chat/quickActions.test.ts.
 */
import type { CreateCalendarEventInput, ErpEventType } from '../../../../models/erp/CalendarEvent';
import { normalizeErpReminderMinutes } from '../../../../shared/erp/erpReminderText';
import { tr } from '../../../../shared/i18n';

export type QuickEventDuration = '15' | '30' | '60' | '90' | '120' | 'all_day';

export const QUICK_EVENT_DURATIONS: Array<{ value: QuickEventDuration; label: string }> = [
  { value: '15', label: tr('15 phút') },
  { value: '30', label: tr('30 phút') },
  { value: '60', label: tr('1 giờ') },
  { value: '90', label: tr('1 giờ 30') },
  { value: '120', label: tr('2 giờ') },
  { value: 'all_day', label: tr('Cả ngày') },
];

export const QUICK_EVENT_TYPES: Array<{ value: ErpEventType; label: string }> = [
  { value: 'appointment', label: tr('Lịch hẹn') },
  { value: 'meeting', label: tr('Cuộc họp') },
  { value: 'reminder', label: tr('Nhắc việc') },
];

export interface QuickEventForm {
  title: string;
  date: string;   // yyyy-mm-dd
  time: string;   // HH:mm
  duration: QuickEventDuration;
  type: ErpEventType;
  /** Reminder offsets (minutes before the appointment, 0 = at the time; empty = no reminder): multi-select, default 15 min + at the time. */
  reminders: number[];
  location: string;
  description: string;
  linkedContactId?: string;
  /** Chat account of the conversation linked to the appointment. */
  linkedAccountId?: string;
  /** Message that created the appointment ("Thêm vào lịch" (Add to calendar) from a message). */
  linkedMsgId?: string;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/** Time → date / time input value (machine local time). */
export function quickEventInputsAt(ts: number): { date: string; time: string } {
  const start = new Date(ts);
  return {
    date: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
    time: `${pad2(start.getHours())}:${pad2(start.getMinutes())}`,
  };
}

/** Default date + time: the next half-hour mark (14:10 → 14:30, 14:40 → 15:00). */
export function defaultQuickEventStart(now: Date = new Date()): { date: string; time: string } {
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  const minutes = start.getMinutes();
  start.setMinutes(minutes < 30 ? 30 : 60);
  return quickEventInputsAt(start.getTime());
}

function localTime(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const t = /^(\d{2}):(\d{2})$/.exec(time || '00:00');
  if (!d || !t) return null;
  const value = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  return Number.isNaN(value.getTime()) || value.getDate() !== Number(d[3]) ? null : value.getTime();
}

export function buildQuickEventInput(form: QuickEventForm): { ok: true; input: CreateCalendarEventInput } | { ok: false; error: string } {
  const title = form.title.trim();
  if (!title) return { ok: false, error: tr('Nhập tiêu đề lịch hẹn') };
  const allDay = form.duration === 'all_day';
  // Message with a date only ("Hôm nay giao hàng" (Delivery today)): the time field is left empty for the user to pick
  if (!allDay && !form.time) return { ok: false, error: tr('Chọn giờ hẹn') };
  const start = localTime(form.date, allDay ? '00:00' : form.time);
  if (start === null) return { ok: false, error: tr('Ngày giờ không hợp lệ') };
  const end = allDay
    ? new Date(new Date(start).getFullYear(), new Date(start).getMonth(), new Date(start).getDate() + 1).getTime() - 1
    : start + Number(form.duration) * 60_000;
  const reminders = normalizeErpReminderMinutes(form.reminders ?? []);
  const input: CreateCalendarEventInput = {
    title,
    type: form.type,
    start_at: start,
    end_at: end,
    all_day: allDay ? 1 : 0,
    ...(form.location.trim() ? { location: form.location.trim() } : {}),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    // 0 = at the appointment time (the popup works like a Zalo appointment reminder); an earlier offset = a notification in the bell, and the title bar bell shakes
    ...(reminders.length ? { reminders: reminders.map(minutes => ({ minutes_before: minutes, channel: 'toast' as const })) } : {}),
    ...(form.linkedContactId ? { linked_contact_id: form.linkedContactId } : {}),
    ...(form.linkedContactId && form.linkedAccountId ? { linked_account_id: form.linkedAccountId } : {}),
    ...(form.linkedContactId && form.linkedMsgId ? { linked_msg_id: form.linkedMsgId } : {}),
  };
  return { ok: true, input };
}

/** Quick note title: the entered title, or if empty the first line of the content (max 60 characters). */
export function quickNoteTitle(title: string, content: string): string {
  const explicit = title.trim();
  if (explicit) return explicit.slice(0, 300);
  const firstLine = content.split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  if (!firstLine) return tr('Ghi chú nhanh');
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}
