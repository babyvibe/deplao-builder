/**
 * autoMarkRead.ts - "Tự động đánh dấu đã đọc" (menu ⋮ → Tự động): which unread conversations to
 * process (time range of their last message) and how fast to call the platforms.
 * Pure, unit-tested in src/__tests__/autoMarkRead.test.ts; the runner lives in store/autoReadStore.
 */

export type AutoReadPreset = 'all' | 'today' | '7d' | '30d' | 'older7d' | 'custom';

export const AUTO_READ_PRESETS: Array<{ id: AutoReadPreset; label: string }> = [
  { id: 'all', label: 'Tất cả' },
  { id: 'today', label: 'Hôm nay' },
  { id: '7d', label: '7 ngày qua' },
  { id: '30d', label: '30 ngày qua' },
  { id: 'older7d', label: 'Cũ hơn 7 ngày' },
  { id: 'custom', label: 'Tuỳ chọn' },
];

/** Range of the last message time, ms, inclusive; a missing bound = open. */
export interface AutoReadRange { from?: number; to?: number }

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "yyyy-mm-dd" (input type=date) → local midnight, or undefined. */
export function parseDateInput(value?: string | null): number | undefined {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const time = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(time) ? time : undefined;
}

/** Days are calendar days in local time ("7 ngày qua" = today + the 6 days before). */
export function resolveAutoReadRange(
  preset: AutoReadPreset,
  custom: { from?: string; to?: string } = {},
  now: number = Date.now(),
): AutoReadRange {
  const today = startOfDay(now);
  switch (preset) {
    case 'today': return { from: today };
    case '7d': return { from: today - 6 * DAY };
    case '30d': return { from: today - 29 * DAY };
    case 'older7d': return { to: today - 6 * DAY - 1 };
    case 'custom': {
      const from = parseDateInput(custom.from);
      const to = parseDateInput(custom.to);
      return {
        ...(from !== undefined ? { from } : {}),
        // inclusive: the whole "to" day
        ...(to !== undefined ? { to: to + DAY - 1 } : {}),
      };
    }
    default: return {};
  }
}

/** Is a custom range usable (from ≤ to when both are set)? */
export function isValidAutoReadRange(range: AutoReadRange): boolean {
  return range.from === undefined || range.to === undefined || range.from <= range.to;
}

/** Pause after a platform call (ms) - keeps bulk read receipts under the platforms' rate limits. */
export const AUTO_READ_PLATFORM_DELAY_MS: Record<string, number> = {
  zalo: 350,
  facebook: 350,
  telegram_user: 800,
};

export function autoReadPlatformDelay(channel?: string | null): number {
  return AUTO_READ_PLATFORM_DELAY_MS[channel || 'zalo'] ?? 300;
}
