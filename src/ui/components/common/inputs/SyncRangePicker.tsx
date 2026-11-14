/**
 * Chooses the time range to sync (last 1 week / pick dates / all): shared by "Đồng bộ tin nhắn từ điện thoại" (Sync messages from phone, Zalo) and
 * "Đồng bộ tin nhắn Facebook" (Sync Facebook messages).
 */
import React from 'react';
import { tr, appLocale } from '../../../../shared/i18n';

export type RangePreset = 'week' | 'custom' | 'all';

/** ms; null = no limit on that side. */
export interface SyncRange {
  fromTs: number | null;
  toTs: number | null;
}

export const RANGE_PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: 'week', label: tr('1 tuần gần nhất') },
  { id: 'custom', label: tr('Chọn ngày') },
  { id: 'all', label: tr('Toàn bộ') },
];

export const WEEK_DAYS = 7;

/** yyyy-mm-dd in local time (do not use toISOString: it is off by one day around midnight in UTC+7). */
export function toDateInput(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Date input value → ms at the start of the day (or the end of the day) in local time. */
export function fromDateInput(value: string, endOfDay = false): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const date = endOfDay
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
    : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** 00:00 of the day `days` days before today. */
export function startOfDaysAgo(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

const fmtDay = (ts: number) => new Date(ts).toLocaleDateString(appLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' });

export function describeRange(range?: SyncRange | null): string {
  if (!range || (!range.fromTs && !range.toTs)) return tr('Toàn bộ lịch sử');
  if (range.fromTs && !range.toTs) return tr('Từ {{v1}} đến nay', { v1: fmtDay(range.fromTs) });
  if (!range.fromTs && range.toTs) return tr('Đến hết {{v1}}', { v1: fmtDay(range.toTs) });
  const from = fmtDay(range.fromTs as number);
  const to = fmtDay(range.toTs as number);
  return from === to ? tr('Ngày {{from}}', { from }) : tr('Từ {{from}} đến hết {{to}}', { from, to });
}

/** Time range for the selection, calculated when clicked (1 week is always counted from today). */
export function resolveRange(preset: RangePreset, from: string, to: string): { range: SyncRange | null; error?: string } {
  if (preset === 'all') return { range: { fromTs: null, toTs: null } };
  if (preset === 'week') return { range: { fromTs: startOfDaysAgo(WEEK_DAYS).getTime(), toTs: null } };
  const fromTs = fromDateInput(from);
  const toTs = fromDateInput(to, true);
  if (!fromTs || !toTs) return { range: null, error: tr('Chọn đủ ngày bắt đầu và ngày kết thúc') };
  if (fromTs > toTs) return { range: null, error: tr('Ngày bắt đầu phải trước ngày kết thúc') };
  return { range: { fromTs, toTs } };
}

export function SyncRangePicker({ preset, from, to, onPreset, onFrom, onTo, allHint }: {
  preset: RangePreset;
  from: string;
  to: string;
  onPreset: (preset: RangePreset) => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  /** Hint shown when "Toàn bộ" (All) is picked. */
  allHint: string;
}) {
  const today = toDateInput(new Date());
  const { range, error } = resolveRange(preset, from, to);
  const hint = error || (preset === 'all' ? allHint : `${describeRange(range)}.`);
  const inputClass = 'flex-1 min-w-0 bg-muted/60 border border-input rounded-lg text-xs text-foreground px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500';

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-foreground/80">{tr('Khoảng thời gian cần đồng bộ')}</p>
      <div className="flex gap-1.5">
        {RANGE_PRESETS.map(option => (
          <button
            key={option.id}
            type="button"
            onClick={() => onPreset(option.id)}
            className={`flex-1 px-2.5 py-1.5 text-xs rounded-lg transition-colors ${
              preset === option.id ? 'bg-blue-600 text-white' : 'bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="flex items-center gap-2">
          <input type="date" value={from} max={to || today} onChange={e => onFrom(e.target.value)}
                 className={inputClass} aria-label={tr('Từ ngày')} />
          <span className="text-subtle-foreground text-xs">→</span>
          <input type="date" value={to} min={from || undefined} max={today} onChange={e => onTo(e.target.value)}
                 className={inputClass} aria-label={tr('Đến ngày')} />
        </div>
      )}
      <p className={`text-[11px] leading-relaxed ${error ? 'text-red-400' : 'text-subtle-foreground'}`}>{hint}</p>
    </div>
  );
}
