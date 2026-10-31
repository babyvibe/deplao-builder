export type ErpDateFilterPreset = 'today' | 'yesterday' | 'last7' | 'last14' | 'last30' | 'custom';

export interface ErpCustomDateRange {
  from: string;
  to: string;
}

export const ERP_DATE_FILTER_OPTIONS: Array<{ id: ErpDateFilterPreset; label: string }> = [
  { id: 'today', label: 'Hôm nay' },
  { id: 'yesterday', label: 'Hôm qua' },
  { id: 'last7', label: '7 ngày qua' },
  { id: 'last14', label: '14 ngày qua' },
  { id: 'last30', label: '1 tháng qua' },
  { id: 'custom', label: 'Custom' },
];

export function startOfDay(ts: number) {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function endOfDay(ts: number) {
  const date = new Date(ts);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function toDateInputValue(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function getDefaultCustomRange(days = 30): ErpCustomDateRange {
  const today = Date.now();
  return {
    from: toDateInputValue(startOfDay(today - (days - 1) * 86400_000)),
    to: toDateInputValue(endOfDay(today)),
  };
}

export function resolveErpDateRange(preset: ErpDateFilterPreset, customRange: ErpCustomDateRange) {
  const today = Date.now();
  const todayStart = startOfDay(today);
  const todayEnd = endOfDay(today);

  if (preset === 'today') return { from: todayStart, to: todayEnd };
  if (preset === 'yesterday') {
    const yesterday = todayStart - 86400_000;
    return { from: startOfDay(yesterday), to: endOfDay(yesterday) };
  }
  if (preset === 'last7') return { from: startOfDay(today - 6 * 86400_000), to: todayEnd };
  if (preset === 'last14') return { from: startOfDay(today - 13 * 86400_000), to: todayEnd };
  if (preset === 'last30') return { from: startOfDay(today - 29 * 86400_000), to: todayEnd };

  if (!customRange.from || !customRange.to) return null;
  const from = startOfDay(new Date(customRange.from).getTime());
  const to = endOfDay(new Date(customRange.to).getTime());
  if (Number.isNaN(from) || Number.isNaN(to) || from > to) return null;
  return { from, to };
}

