/**
 * "Lịch sắp tới" trong chuông thông báo (NotificationCenter → UpcomingEventsTab): lịch Quản lý công việc của mình (tổ
 * chức hoặc được mời, chưa từ chối) từ giờ tới hết 7 ngày tới.
 *
 * Chỉ là danh sách: báo trước / đúng giờ do mốc "Nhắc trước" của TỪNG lịch (main: ErpCalendarService, mặc định 15 phút +
 * đúng giờ) — mỗi dòng ghi mốc nhắc của lịch đó, không có mốc nhắc chung thứ hai (trùng, báo hai lần).
 */
import type { ErpCalendarEvent } from '../../../models/erp/CalendarEvent';
import { erpDurationText, erpRemindersSummary, normalizeErpReminderMinutes } from '../../../shared/erp/erpReminderText';
import { erpRelativeDay, isErpReminderForMe } from './erpReminder';

export const UPCOMING_DAYS = 7;
/** Lịch không có mốc nhắc trước: còn chừng này phút thì tô màu "sắp tới". */
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

/** Khoảng tải lịch: từ bây giờ tới hết ngày thứ 7 kể từ hôm nay. */
export function upcomingRange(now: number): { from: number; to: number } {
  const end = new Date(now);
  end.setDate(end.getDate() + UPCOMING_DAYS);
  return { from: now, to: endOfDay(end.getTime()) };
}

/** Giờ kết thúc thật: lịch cả ngày hết ngày đó; không có giờ kết thúc → giờ bắt đầu. */
export function eventEndAt(event: Pick<ErpCalendarEvent, 'start_at' | 'end_at' | 'all_day'>): number {
  const start = Number(event.start_at) || 0;
  if (event.all_day) return Math.max(endOfDay(start), Number(event.end_at) || 0);
  return Math.max(Number(event.end_at) || 0, start);
}

/** Lịch của mình chưa kết thúc (đang diễn ra hoặc sắp tới), sắp theo giờ bắt đầu. */
export function myUpcomingEvents<T extends UpcomingEvent>(events: readonly T[], myId: string, now: number): T[] {
  return events
    .filter(event => isErpReminderForMe(event, myId) && eventEndAt(event) >= now)
    .sort((a, b) => (Number(a.start_at) || 0) - (Number(b.start_at) || 0));
}

/** "09:00 - 10:30", "09:00", lịch cả ngày: "Cả ngày". */
export function upcomingTimeText(event: Pick<ErpCalendarEvent, 'start_at' | 'end_at' | 'all_day'>): string {
  if (event.all_day) return 'Cả ngày';
  const start = Number(event.start_at) || 0;
  const end = Number(event.end_at) || 0;
  return end > start && startOfDay(end) === startOfDay(start) ? `${hhmm(start)} - ${hhmm(end)}` : hhmm(start);
}

/** Mốc nhắc của lịch: "Nhắc: 15 phút trước, đúng giờ"; không có → "Không nhắc". */
export function upcomingReminderText(event: Pick<ErpCalendarEvent, 'reminders'>): string {
  return erpRemindersSummary((event.reminders || []).map(reminder => Number(reminder?.minutes_before))) || 'Không nhắc';
}

export type UpcomingTone = 'live' | 'soon' | 'later';

/**
 * Trạng thái bên phải mỗi dòng: "Đang diễn ra"; còn ≤ 1 giờ: "còn 25 phút"; trong hôm nay: "còn 3 giờ"; xa hơn: không
 * ghi (ngày ở tiêu đề nhóm). Màu "sắp tới" khi đã tới mốc nhắc trước xa nhất của lịch (không có mốc: 15 phút).
 */
export function upcomingStatus(event: Pick<ErpCalendarEvent, 'start_at' | 'end_at' | 'all_day' | 'reminders'>, now: number): { text: string; tone: UpcomingTone } {
  const start = Number(event.start_at) || 0;
  // Cả ngày: cột giờ đã ghi "Cả ngày", nhóm đã ghi ngày
  if (event.all_day) return { text: '', tone: startOfDay(start) <= now ? 'live' : 'later' };
  if (start <= now) return { text: 'Đang diễn ra', tone: 'live' };
  const minutes = Math.ceil((start - now) / 60_000);
  const advance = normalizeErpReminderMinutes((event.reminders || []).map(reminder => Number(reminder?.minutes_before)))
    .filter(mark => mark > 0);
  const soon = minutes <= (advance[0] ?? SOON_WITHOUT_REMINDER_MINUTES);
  if (minutes <= 60) return { text: `còn ${erpDurationText(minutes)}`, tone: soon ? 'soon' : 'later' };
  if (startOfDay(start) === startOfDay(now)) return { text: `còn ${Math.round(minutes / 60)} giờ`, tone: soon ? 'soon' : 'later' };
  return { text: '', tone: soon ? 'soon' : 'later' };
}

/** Nhóm theo ngày: "Hôm nay", "Ngày mai", "Thứ 6, 07/11". Lịch nhiều ngày đang diễn ra nằm ở hôm nay. */
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
