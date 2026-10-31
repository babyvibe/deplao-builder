/**
 * Date ranges of the Reports page (AnalyticsPage), in local calendar days.
 * Pure — covered by src/__tests__/analyticsRange.test.ts.
 */
import { addLocalDays, localDayDiff, startOfLocalDay } from '../../../shared/analytics/localTimeBuckets';

export type AnalyticsPeriod = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'custom';

export interface AnalyticsRange {
  from: number;
  to: number;
  /** Calendar days covered (chart points for day granularity). */
  periodDays: number;
}

const PRESET_DAYS: Record<'7d' | '30d' | '90d', number> = { '7d': 7, '30d': 30, '90d': 90 };

const pad2 = (value: number) => String(value).padStart(2, '0');

/** "yyyy-mm-dd" of the local date — `toISOString()` gives the UTC date (yesterday before 07:00 in VN). */
export function toLocalDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local midnight of an `<input type="date">` value, or null when it is not a valid date. */
export function parseLocalDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date.getTime() : null;
}

/**
 * "7 ngày" = today + the 6 days before (7 chart points, today included) from local midnight to now;
 * "Hôm qua" = the whole previous day; "Tuỳ chọn" = whole days from..to (swapped if reversed).
 */
export function resolveAnalyticsRange(
  period: AnalyticsPeriod,
  customFrom: string,
  customTo: string,
  now: number = Date.now(),
): AnalyticsRange {
  const today = startOfLocalDay(now);
  if (period === 'today') return { from: today, to: now, periodDays: 1 };
  if (period === 'yesterday') return { from: addLocalDays(today, -1), to: today - 1, periodDays: 1 };
  if (period === 'custom') {
    const a = parseLocalDateInput(customFrom) ?? addLocalDays(today, -29);
    const b = parseLocalDateInput(customTo) ?? today;
    const first = Math.min(a, b);
    const last = Math.max(a, b);
    return { from: first, to: addLocalDays(last, 1) - 1, periodDays: localDayDiff(first, last) + 1 };
  }
  const days = PRESET_DAYS[period];
  return { from: addLocalDays(today, -(days - 1)), to: now, periodDays: days };
}
