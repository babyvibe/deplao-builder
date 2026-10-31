/**
 * Nhắc lịch Quản lý công việc (ERP): mốc nhắc chọn được và chữ hiển thị, dùng chung main (ErpCalendarService: thông báo
 * nhắc trước) và giao diện (chọn mốc khi tạo / sửa lịch, chuông trên thanh tiêu đề, popup đúng giờ).
 * Nhắc trước = thông báo thường trong chuông (đọc là đã đọc) + chuông rung trên thanh tiêu đề; đúng giờ = popup như nhắc
 * hẹn Zalo.
 */

/** Mốc nhắc chọn được (phút trước giờ hẹn, 0 = đúng giờ hẹn). */
export const ERP_REMINDER_CHOICES: readonly number[] = [0, 5, 15, 30, 60, 1440];

/** Lịch mới (trang Lịch, thêm nhanh, từ tin nhắn): nhắc trước 15 phút + đúng giờ. */
export const DEFAULT_ERP_REMINDERS: readonly number[] = [15, 0];

/** 15 → "15 phút", 60 → "1 giờ", 90 → "1 giờ 30 phút", 1440 → "1 ngày". */
export function erpDurationText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440} ngày`;
  if (m >= 60) {
    const hours = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
  }
  return `${m} phút`;
}

/** Nhãn mốc nhắc: 0 → "Đúng giờ", 15 → "15 phút". */
export function erpReminderChoiceLabel(minutes: number): string {
  return minutes === 0 ? 'Đúng giờ' : erpDurationText(minutes);
}

/** Còn bao lâu tới giờ hẹn (làm tròn lên phút: 14 phút 10 giây → "15 phút nữa tới lịch hẹn"); tới giờ → "Đến giờ hẹn". */
export function erpReminderLeadText(msLeft: number): string {
  const minutes = Math.ceil(msLeft / 60_000);
  return minutes <= 0 ? 'Đến giờ hẹn' : `${erpDurationText(minutes)} nữa tới lịch hẹn`;
}

/** Mốc nhắc của lịch (bỏ trùng, sắp lớn → nhỏ) từ danh sách lưu trong DB / form. */
export function normalizeErpReminderMinutes(values: ReadonlyArray<number | { minutes_before: number } | null | undefined>): number[] {
  const out = new Set<number>();
  for (const value of values) {
    const raw = typeof value === 'number' ? value : value?.minutes_before;
    const minutes = Math.round(Number(raw));
    if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 60 * 24 * 30) out.add(minutes);
  }
  return [...out].sort((a, b) => b - a);
}

/** "Nhắc: 15 phút trước, đúng giờ" (chi tiết lịch); không nhắc → ''. */
export function erpRemindersSummary(minutes: readonly number[]): string {
  const list = normalizeErpReminderMinutes([...minutes]);
  if (!list.length) return '';
  return `Nhắc: ${list.map(m => (m === 0 ? 'đúng giờ' : `${erpDurationText(m)} trước`)).join(', ')}`;
}
