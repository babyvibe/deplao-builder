/**
 * Nhắc lịch Quản lý công việc (ERP) trên giao diện: main (ErpCalendarService) phát 'erp:event:reminder' tới giờ nhắc;
 * App.tsx hiện popup "nhắc hẹn" giống nhắc hẹn Zalo (ReminderNotification, có nhạc) khi ĐÚNG GIỜ. Nhắc trước (15 phút…)
 * là thông báo thường trong chuông + chuông rung "15 phút nữa tới lịch hẹn" trên thanh tiêu đề
 * (store/erp/erpReminderAttentionStore). Trước đây sự kiện này chỉ được nghe khi đang mở trang ERP và không ai hiện →
 * lịch hẹn ERP không bao giờ báo.
 *
 * - Chỉ nhắc lịch của mình: người tổ chức hoặc người được mời (máy Boss nhận MỌI sự kiện của cả workspace).
 * - Lịch đã qua lâu (máy tắt lúc tới giờ, mở lại mới nhắc bù) → báo nhẹ "đã lỡ", không bật popup có nhạc.
 */
import type { ErpCalendarEvent, ErpEventType } from '../../../models/erp/CalendarEvent';
import { erpReminderLeadText } from '../../../shared/erp/erpReminderText';

/** Lịch kết thúc quá chừng này mới tới nhắc → coi là đã lỡ. */
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

/** Dòng trên tiêu đề popup / thông báo: "Đến giờ hẹn!" / "15 phút nữa tới lịch hẹn". */
export function erpReminderHeading(minutesBefore: number): string {
  const minutes = Math.max(0, Math.round(Number(minutesBefore) || 0));
  return minutes === 0 ? 'Đến giờ hẹn!' : erpReminderLeadText(minutes * 60_000);
}

const pad2 = (value: number) => String(value).padStart(2, '0');
const WEEKDAYS = ['chủ nhật', 'thứ 2', 'thứ 3', 'thứ 4', 'thứ 5', 'thứ 6', 'thứ 7'];

/** "hôm nay", "ngày mai", "hôm qua", "thứ 6, 30/10". */
export function erpRelativeDay(ts: number, now: Date = new Date()): string {
  const start = new Date(ts);
  const dayDiff = Math.round(
    (new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime()
      - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000,
  );
  return dayDiff === 0 ? 'hôm nay'
    : dayDiff === 1 ? 'ngày mai'
      : dayDiff === -1 ? 'hôm qua'
        : `${WEEKDAYS[start.getDay()]}, ${pad2(start.getDate())}/${pad2(start.getMonth() + 1)}`;
}

/** "09:00 hôm nay", "09:00 ngày mai", "09:00 thứ 6, 30/10"; cả ngày: "Cả ngày hôm nay". */
export function erpReminderWhen(event: Pick<ErpCalendarEvent, 'start_at' | 'all_day'>, now: Date = new Date()): string {
  const start = new Date(event.start_at);
  const dayText = erpRelativeDay(event.start_at, now);
  return event.all_day ? `Cả ngày ${dayText}` : `${pad2(start.getHours())}:${pad2(start.getMinutes())} ${dayText}`;
}

/** Tới nhắc khi lịch đã kết thúc từ lâu (máy tắt lúc tới giờ) → đã lỡ. */
export function isMissedErpReminder(event: Pick<ErpCalendarEvent, 'start_at' | 'end_at'>, now: number = Date.now()): boolean {
  const end = Math.max(Number(event.end_at) || 0, Number(event.start_at) || 0);
  return now - end > ERP_REMINDER_MISSED_AFTER_MS;
}

/**
 * Ghi chú hiện trong popup: bỏ dòng trống thừa, tối đa `maxLines` dòng. `withoutConversationLine`: popup đã có phần hội
 * thoại → bỏ dòng "Hội thoại: …" (thêm vào ghi chú lúc tạo lịch để xem trong trang Lịch).
 */
export function erpReminderNote(description: string | null | undefined, maxLines = 6, withoutConversationLine = false): string {
  const lines = String(description || '').split(/\r?\n/).map(line => line.trimEnd())
    .filter(line => !withoutConversationLine || !line.startsWith('Hội thoại: '));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length <= maxLines) return lines.join('\n');
  return [...lines.slice(0, maxLines), '…'].join('\n');
}
