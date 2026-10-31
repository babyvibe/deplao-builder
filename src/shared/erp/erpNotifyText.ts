/**
 * Chữ của thông báo Quản lý công việc (chuông trong app và tin Zalo): giờ hẹn / hạn task, khoảng giờ của lịch, ngày nghỉ.
 * Dùng chung các service ERP ở main (task, lịch, nghỉ phép). Giờ theo máy chạy service (giờ địa phương).
 * Trước đây chữ dùng `toLocaleString()` (kiểu "10/30/2026, 9:00:00 AM" tuỳ máy) và id nhân viên thay cho tên.
 */

const pad2 = (value: number) => String(value).padStart(2, '0');

const dayOf = (d: Date) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
const timeOf = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** Giờ hẹn / hạn: "09:00" (hôm nay), "09:00 27/10" (ngày khác); cả ngày: "Cả ngày hôm nay" / "Cả ngày 27/10". */
export function erpWhenText(at: number, allDay: boolean, now: number): string {
  const d = new Date(at);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (allDay) return sameDay ? 'Cả ngày hôm nay' : `Cả ngày ${dayOf(d)}`;
  return sameDay ? timeOf(d) : `${timeOf(d)} ${dayOf(d)}`;
}

/**
 * Khoảng giờ của lịch: "09:00 - 10:30" (hôm nay), "09:00 - 10:30 31/10", "09:00 27/10 - 10:00 28/10"; cả ngày nhiều
 * ngày: "Cả ngày 27/10 - 29/10". Không có giờ kết thúc (hoặc kết thúc trước khi bắt đầu) → chỉ giờ bắt đầu.
 */
export function erpTimeRangeText(startAt: number, endAt: number | null | undefined, allDay: boolean, now: number): string {
  const start = erpWhenText(startAt, allDay, now);
  if (!endAt || !Number.isFinite(endAt) || endAt <= startAt) return start;
  const startDate = new Date(startAt);
  if (allDay) {
    // Lịch cả ngày lưu tới nửa đêm hôm sau: lùi 1 ms để lấy đúng ngày cuối
    const last = new Date(endAt - 1);
    return last.toDateString() === startDate.toDateString() ? start : `Cả ngày ${dayOf(startDate)} - ${dayOf(last)}`;
  }
  const end = new Date(endAt);
  if (end.toDateString() === startDate.toDateString()) {
    const today = new Date(now).toDateString() === startDate.toDateString();
    return `${timeOf(startDate)} - ${timeOf(end)}${today ? '' : ` ${dayOf(startDate)}`}`;
  }
  // Qua nhiều ngày: luôn ghi cả hai ngày (tránh "09:00 - 10:00 28/10" hiểu thành cùng ngày 28/10)
  return `${timeOf(startDate)} ${dayOf(startDate)} - ${timeOf(end)} ${dayOf(end)}`;
}

/** Ngày dạng "2026-10-30" → "30/10"; chuỗi khác giữ nguyên. */
export function erpDayText(isoDate: string | null | undefined): string {
  const raw = String(isoDate ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return m ? `${m[3]}/${m[2]}` : raw;
}

/** "30/10" (một ngày) hoặc "30/10 - 31/10". */
export function erpDayRangeText(startDate: string | null | undefined, endDate: string | null | undefined): string {
  const from = erpDayText(startDate);
  const to = erpDayText(endDate);
  return !to || to === from ? from : `${from} - ${to}`;
}

const LEAVE_KINDS: Record<string, string> = {
  annual: 'nghỉ phép năm',
  sick: 'nghỉ ốm',
  unpaid: 'nghỉ không lương',
};

/** Loại nghỉ trong câu ("xin nghỉ ốm 2 ngày"): annual → "nghỉ phép năm"; loại khác → "nghỉ". */
export function erpLeaveKindText(leaveType: string | null | undefined): string {
  return LEAVE_KINDS[String(leaveType ?? '')] ?? 'nghỉ';
}

/** "nghỉ ốm 2 ngày (30/10 - 31/10)"; thiếu số ngày → bỏ phần số ngày. */
export function erpLeaveSummaryText(leave: { leave_type?: string | null; days?: number | null; start_date?: string | null; end_date?: string | null }): string {
  const days = Number(leave.days);
  const range = erpDayRangeText(leave.start_date, leave.end_date);
  return [
    erpLeaveKindText(leave.leave_type),
    Number.isFinite(days) && days > 0 ? `${days} ngày` : '',
    range ? `(${range})` : '',
  ].filter(Boolean).join(' ');
}

/** Cắt chữ dài (lý do nghỉ, ghi chú) cho thông báo: tối đa `max` ký tự, thêm "…". */
export function erpClipText(text: string | null | undefined, max = 120): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
