/**
 * Calendar buckets in the machine's local time for report timelines
 * (main process DatabaseService + renderer AnalyticsPage).
 *
 * SQL groups rows with `sqlLocalDay()` / `sqlLocalHour()` (SQLite 'localtime') and JS builds
 * the matching keys with `localDayKey()` / `localHourKey()`, so a "14/10" bucket always means
 * 14/10 00:00–23:59 local time whatever `sinceTs` is. Bucketing by
 * `(ts - sinceTs) / 86400000` instead made every label hold the afternoon of that day plus the
 * morning of the next one, and the last label ("today") was always empty.
 * Days advance with calendar arithmetic (`new Date(y, m, d + 1)`), never `+ 86400000`.
 */

export interface TimeBucket {
  /** Same text as the SQL expression: "2026-10-14" (day) or "2026-10-14 09" (hour). */
  key: string;
  /** Chart label: "14/10" (day) or "09:00" (hour). */
  label: string;
  /** Local start of the bucket (ms). */
  start: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** About ten years of days / one year of hours — bounds garbage ranges such as sinceTs = 0. */
export const MAX_DAY_BUCKETS = 3660;
export const MAX_HOUR_BUCKETS = 24 * 366;

const pad2 = (value: number) => String(value).padStart(2, '0');

/** Local midnight of the day containing `ts`. */
export function startOfLocalDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Local midnight `days` calendar days after the day containing `ts` (negative = before). */
export function addLocalDays(ts: number, days: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** Calendar days from the day of `fromTs` to the day of `toTs` (0 = same day). */
export function localDayDiff(fromTs: number, toTs: number): number {
  return Math.round((startOfLocalDay(toTs) - startOfLocalDay(fromTs)) / DAY_MS);
}

/** "2026-10-14" — equals `sqlLocalDay()` for the same instant. */
export function localDayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** "2026-10-14 09" — equals `sqlLocalHour()` for the same instant. */
export function localHourKey(ts: number): string {
  return `${localDayKey(ts)} ${pad2(new Date(ts).getHours())}`;
}

/** SQLite expression returning `localDayKey` of a millisecond timestamp column. */
export function sqlLocalDay(column: string): string {
  return `date(${column} / 1000, 'unixepoch', 'localtime')`;
}

/** SQLite expression returning `localHourKey` of a millisecond timestamp column. */
export function sqlLocalHour(column: string): string {
  return `strftime('%Y-%m-%d %H', ${column} / 1000, 'unixepoch', 'localtime')`;
}

function isValidRange(sinceTs: number, untilTs: number): boolean {
  return Number.isFinite(sinceTs) && Number.isFinite(untilTs) && untilTs >= sinceTs;
}

/** Every local calendar day touched by [sinceTs, untilTs] (keeps the most recent `maxDays`). */
export function localDayBuckets(sinceTs: number, untilTs: number, maxDays: number = MAX_DAY_BUCKETS): TimeBucket[] {
  if (!isValidRange(sinceTs, untilTs) || maxDays < 1) return [];
  const lastDay = startOfLocalDay(untilTs);
  const firstDay = Math.max(startOfLocalDay(sinceTs), addLocalDays(lastDay, -(maxDays - 1)));
  const buckets: TimeBucket[] = [];
  for (let day = firstDay; day <= lastDay; day = addLocalDays(day, 1)) {
    const date = new Date(day);
    buckets.push({ key: localDayKey(day), label: `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}`, start: day });
  }
  return buckets;
}

/** Every local clock hour touched by [sinceTs, untilTs], labelled "HH:00" (keeps the most recent `maxHours`). */
export function localHourBuckets(sinceTs: number, untilTs: number, maxHours: number = MAX_HOUR_BUCKETS): TimeBucket[] {
  if (!isValidRange(sinceTs, untilTs) || maxHours < 1) return [];
  const first = new Date(Math.max(sinceTs, untilTs - maxHours * HOUR_MS));
  let cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate(), first.getHours()).getTime();
  const buckets: TimeBucket[] = [];
  while (cursor <= untilTs) {
    const key = localHourKey(cursor);
    // A DST "fall back" repeats a local hour: SQL merges it into one key, so keep one bucket.
    if (buckets.length === 0 || buckets[buckets.length - 1].key !== key) {
      buckets.push({ key, label: `${pad2(new Date(cursor).getHours())}:00`, start: cursor });
    }
    cursor += HOUR_MS;
  }
  return buckets.length > maxHours ? buckets.slice(buckets.length - maxHours) : buckets;
}
