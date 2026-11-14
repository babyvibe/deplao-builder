/**
 * costModel: pure calculations for "Mức sử dụng & chi phí" (Usage & cost) (no I/O, no Electron, tests run standalone):
 *  - Period: UTC calendar month (R2 billing period) and day in Pacific time (America/Los_Angeles, where the daily quota of the Google Drive API
 *    resets at 0:00 Pacific time; a day with a DST change lasts 23 / 25 hours).
 *  - R2 operation types by actionType of GraphQL Analytics (pricing table: developers.cloudflare.com/r2/pricing).
 *  - GB-month from storage samples: peak per UTC day of each bucket, buckets added, days added and divided by 30
 *    ("GB-month = average of the peak storage per day over a 30-day billing period").
 *  - Money rounded the way Cloudflare rounds: usage rounded UP to the next billing unit
 *    (1,1 GB-month → 2; 1.000.001 operations → 2 million), then the free allowance is subtracted.
 *  - Expected end-of-period value at the current pace (linear).
 */
import type { R2OpClass } from '../contracts';
import { R2_PRICING } from '../../../shared/cloud/cloudContracts';

export const SECOND_MS = 1000;
export const HOUR_MS = 60 * 60 * SECOND_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * 1 GB = 10^9 bytes. The R2 price list does not say whether GB or GiB; using 10^9 gives more GB for the same byte count (1 GiB ≈ 1,074 GB)
 * → the estimate is never lower than the real bill.
 */
export const BYTES_PER_GB = 1e9;
/** Cloudflare's GB-month billing period: 30 days (sum of the daily peaks / 30; a 31-day month comes out slightly higher, never lower). */
export const BILLING_PERIOD_DAYS = 30;
export const PACIFIC_TIME_ZONE = 'America/Los_Angeles';

export interface UsagePeriod {
    kind: 'month' | 'day';
    /** 'YYYY-MM' (UTC month) or 'YYYY-MM-DD' (Pacific time day). */
    key: string;
    /** Start of the period (ms, this instant included). */
    startTs: number;
    /** Start of the next period (ms, NOT included); also the moment the quota resets. */
    endTs: number;
}

export interface MonthPeriod extends UsagePeriod {
    kind: 'month';
    /** Number of days in the month (28–31). */
    days: number;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

// ─── UTC month ───────────────────────────────────────────────────────────────

export function utcMonthKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** UTC calendar month containing ts: [1st day 00:00 UTC, 1st day of the next month 00:00 UTC). */
export function utcMonthPeriod(ts: number): MonthPeriod {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const startTs = Date.UTC(y, m, 1);
    const endTs = Date.UTC(y, m + 1, 1);
    return { kind: 'month', key: `${y}-${pad2(m + 1)}`, startTs, endTs, days: Math.round((endTs - startTs) / DAY_MS) };
}

/** Add / subtract months for key 'YYYY-MM' (a malformed key is returned unchanged). */
export function shiftMonthKey(key: string, delta: number): string {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return key;
    const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + Math.trunc(delta);
    const y = Math.floor(idx / 12);
    return `${y}-${pad2(idx - y * 12 + 1)}`;
}

// ─── Pacific time day ────────────────────────────────────────────────────────

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** undefined = not created yet; null = the machine has no time zone data (reduced ICU) → use fixed UTC−8. */
let pacificFormat: Intl.DateTimeFormat | null | undefined;

function pacificFormatter(): Intl.DateTimeFormat | null {
    if (pacificFormat !== undefined) return pacificFormat;
    try {
        pacificFormat = new Intl.DateTimeFormat('en-US', {
            timeZone: PACIFIC_TIME_ZONE,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    } catch {
        pacificFormat = null;
    }
    return pacificFormat;
}

/** Clock time in Los Angeles at ts (milliseconds dropped). */
function pacificWallClock(ts: number): WallClock {
    const fmt = pacificFormatter();
    if (!fmt) {
        const d = new Date(ts - 8 * HOUR_MS);
        return {
            year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
            hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
        };
    }
    const out: WallClock = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    for (const p of fmt.formatToParts(ts)) {
        if (p.type in out) (out as unknown as Record<string, number>)[p.type] = Number(p.value);
    }
    if (out.hour === 24) out.hour = 0; // Old ICU prints "24" for midnight
    return out;
}

/** Offset of Los Angeles time from UTC at ts (ms; negative: −7 h in summer, −8 h in winter). */
function pacificOffsetMs(ts: number): number {
    const w = pacificWallClock(ts);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ts / SECOND_MS) * SECOND_MS;
}

/** 0:00 Los Angeles time on the day year-month-day (ms UTC). Midnight in LA always exists (the clock change happens at 2:00). */
function pacificMidnight(year: number, month: number, day: number): number {
    const asUtc = Date.UTC(year, month - 1, day);
    const first = asUtc - pacificOffsetMs(asUtc);
    return asUtc - pacificOffsetMs(first);
}

export function pacificDayKey(ts: number): string {
    const w = pacificWallClock(ts);
    return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** Pacific time day containing ts: [0:00, next day 0:00) LA time; 23 / 25 hours on a DST-change day. */
export function pacificDayPeriod(ts: number): UsagePeriod {
    const w = pacificWallClock(ts);
    const next = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
    return {
        kind: 'day',
        key: `${w.year}-${pad2(w.month)}-${pad2(w.day)}`,
        startTs: pacificMidnight(w.year, w.month, w.day),
        endTs: pacificMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
    };
}

/** Add / subtract calendar days for key 'YYYY-MM-DD' (time zone independent; a malformed key is returned unchanged). */
export function shiftDayKey(key: string, delta: number): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!m) return key;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Math.trunc(delta)));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ─── R2 operation types (actionType of GraphQL Analytics) ─────────────────────

/** Class A (write / list) per the R2 price list. */
export const R2_CLASS_A_ACTIONS: ReadonlyArray<string> = [
    'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
    'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
    'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
];
/** Class B (read / check). */
export const R2_CLASS_B_ACTIONS: ReadonlyArray<string> = [
    'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
    'GetBucketLifecycleConfiguration',
];
/** Free. */
export const R2_FREE_ACTIONS: ReadonlyArray<string> = ['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload'];

const ACTION_CLASS = new Map<string, R2OpClass>([
    ...R2_CLASS_A_ACTIONS.map(a => [a.toLowerCase(), 'A'] as [string, R2OpClass]),
    ...R2_CLASS_B_ACTIONS.map(a => [a.toLowerCase(), 'B'] as [string, R2OpClass]),
    ...R2_FREE_ACTIONS.map(a => [a.toLowerCase(), 'free'] as [string, R2OpClass]),
]);

/**
 * Operation type by actionType. A type not in the price list (e.g. DeleteObjects, or an operation Cloudflare adds later) → counted as
 * Class A, the most expensive class, so the estimate is never lower than the real bill.
 */
export function classifyR2Action(actionType: string): R2OpClass {
    return ACTION_CLASS.get(String(actionType ?? '').trim().toLowerCase()) ?? 'A';
}

export interface R2OpTotals { classA: number; classB: number; free: number }

/** Add up request counts by type (skip rows with an invalid count). */
export function sumR2Operations(groups: ReadonlyArray<{ actionType: string; requests: number }>): R2OpTotals {
    const t: R2OpTotals = { classA: 0, classB: 0, free: 0 };
    for (const g of groups || []) {
        const n = Number(g?.requests);
        if (!Number.isFinite(n) || n <= 0) continue;
        const c = classifyR2Action(g.actionType);
        if (c === 'B') t.classB += n;
        else if (c === 'free') t.free += n;
        else t.classA += n;
    }
    return t;
}

// ─── R2 storage: GB-month from samples ──────────────────────────────────────────

export interface R2StorageSample {
    bucket: string;
    /** Sample time (ms). */
    ts: number;
    /** payloadSize + metadataSize (byte). */
    bytes: number;
}

export interface R2StorageStats {
    /** Stored now: the latest sample of each bucket added together (bytes). */
    currentBytes: number;
    /** Peak per UTC day from the start of the period to today (buckets added; bytes). Element 0 = first day of the period. */
    dailyPeakBytes: number[];
    /** GB-months used since the start of the period = sum of the daily peaks / 10^9 / 30. */
    gbMonthSoFar: number;
    buckets: number;
}

/**
 * Peak storage per UTC day (from startTs to the day containing now) + current storage.
 *  - Day with no sample: the data is still there → use the latest earlier sample of the bucket.
 *  - Day with samples: peak = max(value carried over from before, samples of the day) (from 0:00 until the first sample,
 *    the data still has the old value).
 *  - Before the bucket's first sample: 0 (the bucket may not exist yet), except with backfill (the result was cut at the row limit, so the oldest
 *    sample is missing): use the earliest sample available for the earlier days (not lower).
 *  - Samples after now (clock skew) count toward the last day.
 */
export function r2StorageStats(
    samples: ReadonlyArray<R2StorageSample>,
    opts: { startTs: number; now: number; backfill?: boolean },
): R2StorageStats {
    const { startTs } = opts;
    // A month is at most 31 days; clamp so bad input (startTs = 0…) does not create a huge array.
    const lastDay = Math.min(400, Math.max(0, Math.floor((opts.now - startTs) / DAY_MS)));
    const daily: number[] = new Array(lastDay + 1).fill(0);
    const byBucket = new Map<string, R2StorageSample[]>();
    for (const s of samples || []) {
        if (!s || !Number.isFinite(s.ts) || !Number.isFinite(s.bytes)) continue;
        const bucket = String(s.bucket ?? '');
        let list = byBucket.get(bucket);
        if (!list) {
            list = [];
            byBucket.set(bucket, list);
        }
        list.push({ bucket, ts: s.ts, bytes: Math.max(0, s.bytes) });
    }
    let currentBytes = 0;
    for (const list of byBucket.values()) {
        list.sort((a, b) => a.ts - b.ts);
        currentBytes += list[list.length - 1].bytes;
        let i = 0;
        // Value in place at the start of the period: the last sample before startTs (if any).
        let carry: number | null = null;
        while (i < list.length && list[i].ts < startTs) carry = list[i++].bytes;
        if (carry === null && opts.backfill && i < list.length) carry = list[i].bytes;
        for (let d = 0; d <= lastDay; d++) {
            const dayEnd = startTs + (d + 1) * DAY_MS;
            let peak = carry ?? 0;
            while (i < list.length && (d === lastDay || list[i].ts < dayEnd)) {
                if (list[i].bytes > peak) peak = list[i].bytes;
                carry = list[i++].bytes;
            }
            daily[d] += peak;
        }
    }
    return { currentBytes, dailyPeakBytes: daily, gbMonthSoFar: gbMonthFromDailyPeaks(daily), buckets: byBucket.size };
}

/** GB-months from the daily peaks (bytes): sum / 10^9 / 30. */
export function gbMonthFromDailyPeaks(dailyPeakBytes: ReadonlyArray<number>): number {
    let sum = 0;
    for (const b of dailyPeakBytes || []) if (Number.isFinite(b) && b > 0) sum += b;
    return sum / BYTES_PER_GB / BILLING_PERIOD_DAYS;
}

// ─── Elapsed time + projection ──────────────────────────────────────────────

/** Days (UTC) elapsed in the month, today included (1..days); each day counts at its own peak. */
export function elapsedMonthDays(now: number, period: { startTs: number; days: number }): number {
    const d = Math.floor((now - period.startTs) / DAY_MS) + 1;
    return Math.min(period.days, Math.max(1, d));
}

/** Fraction of the period elapsed (0..1), never below minFraction (so the start of the period does not inflate the projection). */
export function elapsedFraction(now: number, period: { startTs: number; endTs: number }, minFraction: number): number {
    const len = period.endTs - period.startTs;
    const f = len > 0 ? (now - period.startTs) / len : 1;
    return Math.min(1, Math.max(minFraction > 0 ? minFraction : 0, Number.isFinite(f) ? f : 1));
}

/** Projected end-of-period value at the current pace: used / fraction elapsed (rounded to an integer, never below used). */
export function linearProjection(used: number, fraction: number): number {
    if (!Number.isFinite(used) || used <= 0) return 0;
    const f = Number.isFinite(fraction) && fraction > 0 ? Math.min(1, fraction) : 1;
    return Math.max(Math.round(used), Math.round(used / f));
}

// ─── Money (USD) ──────────────────────────────────────────────────────────────

/** Round UP to the billing unit; drop tiny floating-point errors (10,000000000000002 GB-month is still 10). */
export function ceilUnits(x: number): number {
    if (!Number.isFinite(x) || x <= 0) return 0;
    return Math.max(0, Math.ceil(x - 1e-9));
}

/** Drop floating-point error in money (round to 10^-6 USD). */
export function roundUsd(x: number): number {
    return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : 0;
}

/** R2 storage fee (USD) for a GB-month count: subtract 10 free GB-months, round the rest up per GB-month. */
export function r2StorageCostUsd(gbMonth: number): number {
    return roundUsd(ceilUnits(gbMonth - R2_PRICING.freeStorageGbMonth) * R2_PRICING.storageUsdPerGbMonth);
}

/** R2 operation fee (USD): subtract the free allowance (A: 1 million, B: 10 million), round the rest up per million. */
export function r2OpsCostUsd(ops: number, cls: 'A' | 'B'): number {
    const free = cls === 'A' ? R2_PRICING.freeClassA : R2_PRICING.freeClassB;
    const price = cls === 'A' ? R2_PRICING.classAUsdPerMillion : R2_PRICING.classBUsdPerMillion;
    return roundUsd(ceilUnits((ops - free) / 1_000_000) * price);
}
