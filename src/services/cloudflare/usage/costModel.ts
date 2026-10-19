/**
 * costModel — phép tính thuần cho "Mức sử dụng & chi phí" (không I/O, không Electron — test độc lập):
 *  - Kỳ: tháng dương lịch UTC (kỳ tính tiền R2) và ngày theo giờ Thái Bình Dương (America/Los_Angeles — hạn mức ngày
 *    của Google Drive API đặt lại lúc 0:00 giờ Thái Bình Dương; ngày đổi giờ dài 23 / 25 tiếng).
 *  - Loại thao tác R2 theo actionType của GraphQL Analytics (bảng giá developers.cloudflare.com/r2/pricing).
 *  - GB-tháng từ mẫu dung lượng: đỉnh mỗi ngày UTC của từng bucket, cộng các bucket, tổng các ngày chia 30
 *    ("GB-month = average of the peak storage per day over a 30-day billing period").
 *  - Tiền theo cách làm tròn của Cloudflare: lượng dùng làm tròn LÊN tới đơn vị tính tiền kế tiếp
 *    (1,1 GB-tháng → 2; 1.000.001 thao tác → 2 triệu) rồi trừ phần miễn phí.
 *  - Dự kiến cuối kỳ theo nhịp hiện tại (tuyến tính).
 */
import type { R2OpClass } from '../contracts';
import { R2_PRICING } from '../../../shared/cloudContracts';

export const SECOND_MS = 1000;
export const HOUR_MS = 60 * 60 * SECOND_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * 1 GB = 10^9 byte. Bảng giá R2 không nói rõ GB hay GiB; lấy 10^9 thì cùng số byte ra nhiều GB hơn (1 GiB ≈ 1,074 GB)
 * → ước tính không bao giờ thấp hơn hoá đơn thật.
 */
export const BYTES_PER_GB = 1e9;
/** Kỳ tính GB-tháng của Cloudflare: 30 ngày (tổng đỉnh mỗi ngày / 30 — tháng 31 ngày ra nhỉnh hơn một chút, không thấp). */
export const BILLING_PERIOD_DAYS = 30;
export const PACIFIC_TIME_ZONE = 'America/Los_Angeles';

export interface UsagePeriod {
    kind: 'month' | 'day';
    /** 'YYYY-MM' (tháng UTC) hoặc 'YYYY-MM-DD' (ngày giờ Thái Bình Dương). */
    key: string;
    /** Đầu kỳ (ms, tính cả mốc này). */
    startTs: number;
    /** Đầu kỳ sau (ms, KHÔNG tính) — cũng là lúc hạn mức đặt lại. */
    endTs: number;
}

export interface MonthPeriod extends UsagePeriod {
    kind: 'month';
    /** Số ngày của tháng (28–31). */
    days: number;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

// ─── Tháng UTC ───────────────────────────────────────────────────────────────

export function utcMonthKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** Tháng dương lịch UTC chứa ts: [ngày 1 00:00 UTC, ngày 1 tháng sau 00:00 UTC). */
export function utcMonthPeriod(ts: number): MonthPeriod {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const startTs = Date.UTC(y, m, 1);
    const endTs = Date.UTC(y, m + 1, 1);
    return { kind: 'month', key: `${y}-${pad2(m + 1)}`, startTs, endTs, days: Math.round((endTs - startTs) / DAY_MS) };
}

/** Cộng / trừ tháng cho khoá 'YYYY-MM' (khoá sai dạng trả nguyên). */
export function shiftMonthKey(key: string, delta: number): string {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return key;
    const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + Math.trunc(delta);
    const y = Math.floor(idx / 12);
    return `${y}-${pad2(idx - y * 12 + 1)}`;
}

// ─── Ngày giờ Thái Bình Dương ────────────────────────────────────────────────

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** undefined = chưa tạo; null = máy không có dữ liệu múi giờ (ICU rút gọn) → dùng UTC−8 cố định. */
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

/** Giờ đồng hồ ở Los Angeles tại ts (bỏ phần ms). */
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
    if (out.hour === 24) out.hour = 0; // ICU cũ in "24" cho nửa đêm
    return out;
}

/** Độ lệch giờ Los Angeles so với UTC tại ts (ms; âm: −7 h mùa hè, −8 h mùa đông). */
function pacificOffsetMs(ts: number): number {
    const w = pacificWallClock(ts);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ts / SECOND_MS) * SECOND_MS;
}

/** 0:00 giờ Los Angeles của ngày year-month-day (ms UTC). Nửa đêm ở LA luôn tồn tại (đổi giờ lúc 2:00). */
function pacificMidnight(year: number, month: number, day: number): number {
    const asUtc = Date.UTC(year, month - 1, day);
    const first = asUtc - pacificOffsetMs(asUtc);
    return asUtc - pacificOffsetMs(first);
}

export function pacificDayKey(ts: number): string {
    const w = pacificWallClock(ts);
    return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** Ngày theo giờ Thái Bình Dương chứa ts: [0:00, 0:00 hôm sau) giờ LA — 23 / 25 tiếng vào ngày đổi giờ. */
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

/** Cộng / trừ ngày lịch cho khoá 'YYYY-MM-DD' (không phụ thuộc múi giờ; khoá sai dạng trả nguyên). */
export function shiftDayKey(key: string, delta: number): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!m) return key;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Math.trunc(delta)));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ─── Loại thao tác R2 (actionType của GraphQL Analytics) ─────────────────────

/** Class A (ghi / liệt kê) theo bảng giá R2. */
export const R2_CLASS_A_ACTIONS: ReadonlyArray<string> = [
    'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
    'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
    'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
];
/** Class B (đọc / kiểm tra). */
export const R2_CLASS_B_ACTIONS: ReadonlyArray<string> = [
    'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
    'GetBucketLifecycleConfiguration',
];
/** Miễn phí. */
export const R2_FREE_ACTIONS: ReadonlyArray<string> = ['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload'];

const ACTION_CLASS = new Map<string, R2OpClass>([
    ...R2_CLASS_A_ACTIONS.map(a => [a.toLowerCase(), 'A'] as [string, R2OpClass]),
    ...R2_CLASS_B_ACTIONS.map(a => [a.toLowerCase(), 'B'] as [string, R2OpClass]),
    ...R2_FREE_ACTIONS.map(a => [a.toLowerCase(), 'free'] as [string, R2OpClass]),
]);

/**
 * Loại thao tác theo actionType. Loại không có trong bảng giá (vd DeleteObjects, thao tác Cloudflare thêm sau) → tính
 * Class A — loại đắt nhất, để ước tính không thấp hơn hoá đơn thật.
 */
export function classifyR2Action(actionType: string): R2OpClass {
    return ACTION_CLASS.get(String(actionType ?? '').trim().toLowerCase()) ?? 'A';
}

export interface R2OpTotals { classA: number; classB: number; free: number }

/** Cộng số request theo loại (bỏ dòng số lượng không hợp lệ). */
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

// ─── Dung lượng R2: GB-tháng từ mẫu ──────────────────────────────────────────

export interface R2StorageSample {
    bucket: string;
    /** Thời điểm mẫu (ms). */
    ts: number;
    /** payloadSize + metadataSize (byte). */
    bytes: number;
}

export interface R2StorageStats {
    /** Đang lưu: mẫu mới nhất của từng bucket cộng lại (byte). */
    currentBytes: number;
    /** Đỉnh mỗi ngày UTC từ đầu kỳ tới hôm nay (cộng các bucket; byte) — phần tử 0 = ngày đầu kỳ. */
    dailyPeakBytes: number[];
    /** GB-tháng đã dùng từ đầu kỳ = tổng đỉnh các ngày / 10^9 / 30. */
    gbMonthSoFar: number;
    buckets: number;
}

/**
 * Đỉnh dung lượng mỗi ngày UTC (từ startTs tới ngày chứa now) + dung lượng hiện tại.
 *  - Ngày không có mẫu: dữ liệu vẫn nằm đó → dùng giá trị mẫu gần nhất trước đó của bucket.
 *  - Ngày có mẫu: đỉnh = max(giá trị mang từ trước sang, các mẫu trong ngày) (từ 0:00 tới mẫu đầu tiên dữ liệu vẫn là giá
 *    trị cũ).
 *  - Trước mẫu đầu tiên của bucket: 0 (bucket có thể chưa có) — trừ khi backfill (kết quả bị cắt ở giới hạn dòng, mẫu cũ
 *    nhất bị thiếu): lấy mẫu sớm nhất đang có cho các ngày trước đó (không thấp).
 *  - Mẫu sau now (lệch đồng hồ) tính vào ngày cuối.
 */
export function r2StorageStats(
    samples: ReadonlyArray<R2StorageSample>,
    opts: { startTs: number; now: number; backfill?: boolean },
): R2StorageStats {
    const { startTs } = opts;
    // Kỳ tháng ≤ 31 ngày; kẹp để đầu vào sai (startTs = 0…) không tạo mảng khổng lồ.
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
        // Giá trị đang có lúc đầu kỳ: mẫu cuối cùng trước startTs (nếu có).
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

/** GB-tháng từ đỉnh mỗi ngày (byte): tổng / 10^9 / 30. */
export function gbMonthFromDailyPeaks(dailyPeakBytes: ReadonlyArray<number>): number {
    let sum = 0;
    for (const b of dailyPeakBytes || []) if (Number.isFinite(b) && b > 0) sum += b;
    return sum / BYTES_PER_GB / BILLING_PERIOD_DAYS;
}

// ─── Thời gian đã qua + dự kiến ──────────────────────────────────────────────

/** Số ngày (UTC) đã qua của tháng, tính cả hôm nay (1..days) — mỗi ngày tính bằng đỉnh của ngày đó. */
export function elapsedMonthDays(now: number, period: { startTs: number; days: number }): number {
    const d = Math.floor((now - period.startTs) / DAY_MS) + 1;
    return Math.min(period.days, Math.max(1, d));
}

/** Phần kỳ đã qua (0..1), không thấp hơn minFraction (đầu kỳ không nhân lên quá mức). */
export function elapsedFraction(now: number, period: { startTs: number; endTs: number }, minFraction: number): number {
    const len = period.endTs - period.startTs;
    const f = len > 0 ? (now - period.startTs) / len : 1;
    return Math.min(1, Math.max(minFraction > 0 ? minFraction : 0, Number.isFinite(f) ? f : 1));
}

/** Dự kiến cuối kỳ theo nhịp hiện tại: used / phần kỳ đã qua (làm tròn số nguyên, không nhỏ hơn used). */
export function linearProjection(used: number, fraction: number): number {
    if (!Number.isFinite(used) || used <= 0) return 0;
    const f = Number.isFinite(fraction) && fraction > 0 ? Math.min(1, fraction) : 1;
    return Math.max(Math.round(used), Math.round(used / f));
}

// ─── Tiền (USD) ──────────────────────────────────────────────────────────────

/** Làm tròn LÊN tới đơn vị tính tiền; bỏ sai số dấu phẩy động rất nhỏ (10,000000000000002 GB-tháng vẫn là 10). */
export function ceilUnits(x: number): number {
    if (!Number.isFinite(x) || x <= 0) return 0;
    return Math.max(0, Math.ceil(x - 1e-9));
}

/** Bỏ sai số dấu phẩy động của tiền (làm tròn tới 10^-6 USD). */
export function roundUsd(x: number): number {
    return Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : 0;
}

/** Phí dung lượng R2 (USD) cho số GB-tháng: trừ 10 GB-tháng miễn phí, phần còn lại làm tròn lên từng GB-tháng. */
export function r2StorageCostUsd(gbMonth: number): number {
    return roundUsd(ceilUnits(gbMonth - R2_PRICING.freeStorageGbMonth) * R2_PRICING.storageUsdPerGbMonth);
}

/** Phí thao tác R2 (USD): trừ phần miễn phí (A: 1 triệu, B: 10 triệu), phần còn lại làm tròn lên từng triệu. */
export function r2OpsCostUsd(ops: number, cls: 'A' | 'B'): number {
    const free = cls === 'A' ? R2_PRICING.freeClassA : R2_PRICING.freeClassB;
    const price = cls === 'A' ? R2_PRICING.classAUsdPerMillion : R2_PRICING.classBUsdPerMillion;
    return roundUsd(ceilUnits((ops - free) / 1_000_000) * price);
}
