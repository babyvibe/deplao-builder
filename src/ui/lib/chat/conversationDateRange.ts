/**
 * Lọc danh sách hội thoại theo khoảng ngày (menu ⋮): theo thời điểm tin cuối của hội thoại, ngày theo giờ máy (00:00 →
 * 23:59:59 giờ địa phương). DB lọc cùng quy tắc (DatabaseService.getContactsFiltered: fromTs / toTs; bản ghi cũ lưu
 * giây được đổi ra mili-giây trước khi so).
 */
export type DateRangePreset = 'today' | '3d' | '7d' | '30d' | 'custom';

export interface ConversationDateRange {
  preset: DateRangePreset;
  fromTs: number;
  toTs: number;
  label: string;
}

export const DATE_RANGE_PRESETS: ReadonlyArray<{ preset: Exclude<DateRangePreset, 'custom'>; label: string }> = [
  { preset: 'today', label: 'Hôm nay' },
  { preset: '3d', label: '3 ngày qua' },
  { preset: '7d', label: '7 ngày qua' },
  { preset: '30d', label: '30 ngày qua' },
];

const PRESET_DAYS: Record<Exclude<DateRangePreset, 'custom'>, number> = { today: 1, '3d': 3, '7d': 7, '30d': 30 };

export function localDayStart(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function localDayEnd(ts: number): number {
  const date = new Date(ts);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

/** "Hôm nay" / "N ngày qua": tính cả hôm nay, từ 00:00 của ngày đầu. */
export function presetDateRange(preset: Exclude<DateRangePreset, 'custom'>, now = Date.now()): ConversationDateRange {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (PRESET_DAYS[preset] - 1));
  const label = DATE_RANGE_PRESETS.find((item) => item.preset === preset)?.label || preset;
  return { preset, fromTs: start.getTime(), toTs: localDayEnd(now), label };
}

function parseDateInput(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return NaN;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

const shortDate = (ts: number) => {
  const date = new Date(ts);
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
};

/** Hai ô chọn ngày ("yyyy-mm-dd") → khoảng; thiếu một đầu = một ngày, nhập ngược thì đảo lại. */
export function customDateRange(from: string, to: string): ConversationDateRange | null {
  let start = parseDateInput(from);
  let end = parseDateInput(to);
  if (!Number.isFinite(start) && !Number.isFinite(end)) return null;
  if (!Number.isFinite(start)) start = end;
  if (!Number.isFinite(end)) end = start;
  if (start > end) [start, end] = [end, start];
  const label = start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`;
  return { preset: 'custom', fromTs: localDayStart(start), toTs: localDayEnd(end), label };
}

/** Giá trị cho <input type="date"> (giờ máy). */
export function toDateInputValue(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Tin cuối của hội thoại nằm trong khoảng (null = không lọc). */
export function inConversationDateRange(lastMessageTime: unknown, range: ConversationDateRange | null | undefined): boolean {
  if (!range) return true;
  let ts = Number(lastMessageTime) || 0;
  if (ts > 0 && ts < 1e11) ts *= 1000;
  return ts >= range.fromTs && ts <= range.toTs;
}
