/**
 * ERP calendar reminders in the UI: main (ErpCalendarService) emits 'erp:event:reminder' at the reminder time;
 * App.tsx shows a "nhắc hẹn" popup like the Zalo reminder (ReminderNotification, with sound) at the exact time. Early reminders (15 minutes…)
 * are regular notifications in the bell, and the bell rings with "15 phút nữa tới lịch hẹn" on the title bar
 * (store/erp/erpReminderAttentionStore). Previously this event was only heard while the ERP page was open, and nothing was shown, so
 * ERP appointments never alerted.
 *
 * - Only reminders for your own events: the organizer or an invitee (the owner's machine receives ALL events of the whole workspace).
 * - Events that ended long ago (the machine was off at the due time, so the reminder is made up on reopen) → a quiet notice marked "đã lỡ" (missed), with no popup and no sound.
 */
import type { ErpCalendarEvent, ErpEventType } from '../../../models/erp/CalendarEvent';
import { erpReminderLeadText } from '../../../shared/erp/erpReminderText';
import { tr } from '../../../shared/i18n';

/** An event that ended longer ago than this, when its reminder arrives, counts as missed. */
export const ERP_REMINDER_MISSED_AFTER_MS = 10 * 60_000;

export const ERP_EVENT_EMOJI: Record<ErpEventType, string> = {
  appointment: '📅',
  meeting: '👥',
  reminder: '⏰',
  task: '📋',
  leave: '🌴',
};

export function isErpReminderForMe(event: Pick<ErpCalendarEvent, 'organizer_id' | 'attendees'> | null | undefined, myId: string): boolean {
  if (!event || !myId) return false;
  if (String(event.organizer_id || '') === myId) return true;
  return !!event.attendees?.some(attendee => String(attendee.employee_id) === myId && attendee.status !== 'declined');
}

/** Line in the popup / notification title: "Đến giờ hẹn!" / "15 phút nữa tới lịch hẹn". */
export function erpReminderHeading(minutesBefore: number): string {
  const minutes = Math.max(0, Math.round(Number(minutesBefore) || 0));
  return minutes === 0 ? tr('Đến giờ hẹn!') : erpReminderLeadText(minutes * 60_000);
}

const pad2 = (value: number) => String(value).padStart(2, '0');
const WEEKDAYS = [tr('chủ nhật'), tr('thứ 2'), tr('thứ 3'), tr('thứ 4'), tr('thứ 5'), tr('thứ 6'), tr('thứ 7')];

/** "hôm nay" (today), "ngày mai" (tomorrow), "hôm qua" (yesterday), "thứ 6, 30/10" (Friday 30/10). */
export function erpRelativeDay(ts: number, now: Date = new Date()): string {
  const start = new Date(ts);
  const dayDiff = Math.round(
    (new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
      - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000,
  );
  return dayDiff === 0 ? tr('hôm nay')
    : dayDiff === 1 ? tr('ngày mai')
      : dayDiff === -1 ? tr('hôm qua')
        : `${WEEKDAYS[start.getDay()]}, ${pad2(start.getDate())}/${pad2(start.getMonth() + 1)}`;
}

/** "09:00 hôm nay", "09:00 ngày mai", "09:00 thứ 6, 30/10"; all-day: "Cả ngày hôm nay". */
export function erpReminderWhen(event: Pick<ErpCalendarEvent, 'start_at' | 'all_day'>, now: Date = new Date()): string {
  const start = new Date(event.start_at);
  const dayText = erpRelativeDay(event.start_at, now);
  return event.all_day ? tr('Cả ngày {{dayText}}', { dayText }) : `${pad2(start.getHours())}:${pad2(start.getMinutes())} ${dayText}`;
}

/** A reminder that arrives after the event ended long ago (the machine was off at the due time) → missed. */
export function isMissedErpReminder(event: Pick<ErpCalendarEvent, 'start_at' | 'end_at'>, now: number = Date.now()): boolean {
  const end = Math.max(Number(event.end_at) || 0, Number(event.start_at) || 0);
  return now - end > ERP_REMINDER_MISSED_AFTER_MS;
}

/**
 * Note text shown in the popup: drops extra blank lines, at most `maxLines` lines. `withoutConversationLine`: when the popup already has
 * the conversation section, drops the "Hội thoại: …" line (added to the note when the event was created, so it shows on the Calendar page).
 */
export function erpReminderNote(description: string | null | undefined, maxLines = 6, withoutConversationLine = false): string {
  const lines = String(description || '').split(/\r?\n/).map(line => line.trimEnd())
    .filter(line => !withoutConversationLine || !line.startsWith('Hội thoại: '));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length <= maxLines) return lines.join('\n');
  return [...lines.slice(0, maxLines), '…'].join('\n');
}
