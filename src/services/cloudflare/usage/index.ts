/**
 * Mức sử dụng & chi phí của kho đang chọn (Cài đặt → Đồng bộ dữ liệu) — `core.usage`.
 *
 *  - Đếm thao tác của Deplao trên máy này (UsageMeter): R2Client gọi recordR2 sau mỗi request tới R2, client Google Drive
 *    gọi recordGoogle. Đường nóng: O(1), không ném.
 *  - R2 (kỳ = tháng dương lịch UTC): số liệu toàn tài khoản qua GraphQL Analytics (r2Analytics) khi đã kết nối Cloudflare —
 *    nhớ 10 phút, refresh đọc lại nếu lần đọc trước đã ≥ 60 s. Token thiếu quyền "Account Analytics: Read" / lỗi → dùng
 *    số đếm trên máy + ghi chú cho người dùng.
 *  - Google Drive (kỳ = ngày giờ Thái Bình Dương): dung lượng tài khoản (core().google) + số đếm trên máy. Dưới ngưỡng
 *    Google không tính phí → tiền luôn 0.
 *  - report() không bao giờ ném: lỗi gì cũng trả số liệu trên máy.
 *
 * createCloudUsage không làm gì lúc tạo (không đọc file, không gọi electron / mạng, không gọi core()).
 */
import * as path from 'path';
import type {
    CloudStorageProvider, CloudUsageMeter, CloudUsageReport, GoogleDriveStatus,
} from '../../../shared/cloudContracts';
import { GDRIVE_LIMITS, R2_PRICING } from '../../../shared/cloudContracts';
import type { CloudflareApi, CloudflareCore, CloudUsageModule, R2OpClass } from '../contracts';
import Logger from '../../../utils/Logger';
import { UsageMeter } from './UsageMeter';
import { R2AnalyticsData, fetchR2Analytics, shortReason } from './r2Analytics';
import {
    BILLING_PERIOD_DAYS, BYTES_PER_GB, MonthPeriod, elapsedFraction, elapsedMonthDays, linearProjection,
    pacificDayPeriod, r2OpsCostUsd, r2StorageCostUsd, r2StorageStats, roundUsd, utcMonthPeriod,
} from './costModel';

export * from './costModel';
export * from './UsageMeter';
export * from './r2Analytics';

export const CLOUD_USAGE_FILE = 'cloud-usage.json';
/** Số liệu toàn tài khoản (R2) dùng lại trong 10 phút. */
export const ACCOUNT_CACHE_MS = 10 * 60_000;
/** refresh chỉ đọc lại khi lần đọc trước đã ≥ 60 s. */
export const ACCOUNT_REFRESH_MIN_MS = 60_000;
/** Dung lượng Google cũ hơn 10 phút → refresh đọc lại. */
export const GOOGLE_QUOTA_MAX_AGE_MS = 10 * 60_000;
/** report() chờ số liệu Cloudflare tối đa bấy nhiêu; quá → dùng số trên máy (truy vấn vẫn chạy, lần sau có). */
const ACCOUNT_WAIT_MS = 25_000;
const GOOGLE_REFRESH_WAIT_MS = 20_000;
/** Ngân sách request Cloudflare còn ít hơn → không đọc analytics (nhường tunnel / R2), dùng bản nhớ / số trên máy. */
const MIN_API_BUDGET = 5;

export const R2_NOTE_NO_PERMISSION = 'Token Cloudflare chưa có quyền "Account Analytics: Read" — thêm quyền này vào token '
    + '(Quản lý → Đổi token) để xem số liệu toàn tài khoản. Hiện chỉ đếm thao tác của Deplao trên máy này.';
export const R2_NOTE_NOT_CONNECTED = 'Chưa kết nối Cloudflare — chỉ có số đếm của Deplao trên máy này.';
export const GOOGLE_NOTE = 'Google không cho đọc mức dùng hạn mức của project — số lượt và dung lượng tải là của Deplao trên máy này.';
export const GOOGLE_NOTE_NOT_CONNECTED = 'Chưa đăng nhập Google Drive — chỉ có số đếm của Deplao trên máy này.';

export function r2NoteFailed(reason: string): string {
    return `Chưa đọc được số liệu từ Cloudflare (${reason}) — tạm dùng số đếm của Deplao trên máy này.`;
}

export interface CloudUsageDeps {
    /** Lõi Cloudflare — getter gọi muộn (không bao giờ gọi trong createCloudUsage). */
    core: () => CloudflareCore;
    /** Byte Deplao đã đẩy lên kho (media đã lên + bản sao DB) — dùng khi không có số liệu toàn tài khoản. */
    localStoredBytes?: () => number;
    /** Mặc định userData/cloud-usage.json (require('electron') muộn). */
    filePath?: () => string;
    now?: () => number;
    /** Mặc định Logger. */
    log?: (level: 'log' | 'warn', msg: string) => void;
}

interface AccountEntry {
    /** accountId|tokenId|tháng — đổi tài khoản / token / sang tháng mới thì đọc lại. */
    key: string;
    /** Lúc đọc xong (ms). */
    at: number;
    data: R2AnalyticsData | null;
    note: string | null;
}

type AccountView = { data: R2AnalyticsData | null; note: string | null };

function defaultUsageFilePath(): string {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), CLOUD_USAGE_FILE);
}

function errText(err: unknown): string {
    return shortReason(err);
}

function finiteNonNegative(n: unknown): number {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Chờ promise tối đa ms; quá hạn / lỗi → null (promise vẫn chạy tiếp). */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        (timer as any)?.unref?.();
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

function sumCost(meters: CloudUsageMeter[]): { soFar: number; projected: number } {
    let soFar = 0;
    let projected = 0;
    for (const m of meters) {
        soFar += m.costSoFar;
        projected += m.costProjected;
    }
    return { soFar: roundUsd(soFar), projected: roundUsd(projected) };
}

class CloudUsage implements CloudUsageModule {
    private readonly meter: UsageMeter;
    private account: AccountEntry | null = null;
    private inflight: { key: string; promise: Promise<AccountEntry> } | null = null;

    constructor(private readonly deps: CloudUsageDeps) {
        this.meter = new UsageMeter({
            filePath: deps.filePath ?? defaultUsageFilePath,
            now: () => this.now(),
            log: (level, msg) => this.log(level, msg),
        });
    }

    recordR2(op: R2OpClass, bytes?: { up?: number; down?: number }): void {
        try {
            this.meter.recordR2(op, bytes?.up, bytes?.down);
        } catch { /* bộ đếm lỗi không làm hỏng request */ }
    }

    recordGoogle(units: number, bytes?: { up?: number; down?: number }): void {
        try {
            this.meter.recordGoogle(units, bytes?.up, bytes?.down);
        } catch { /* bộ đếm lỗi không làm hỏng request */ }
    }

    flush(): void {
        try {
            this.meter.flush();
        } catch { /* bỏ qua */ }
    }

    async report(opts?: { refresh?: boolean }): Promise<CloudUsageReport> {
        const now = this.now();
        const refresh = !!opts?.refresh;
        let provider: CloudStorageProvider = 'r2';
        try {
            if (this.deps.core().storageProvider() === 'gdrive') provider = 'gdrive';
        } catch { /* chưa có lõi → R2 */ }
        try {
            return provider === 'gdrive' ? await this.googleReport(now, refresh) : await this.r2Report(now, refresh);
        } catch (err) {
            this.log('warn', `[CloudUsage] lỗi khi lập báo cáo ${provider}: ${errText(err)}`);
            return this.emptyReport(provider, now, errText(err));
        }
    }

    // ── R2 ──

    private async r2Report(now: number, refresh: boolean): Promise<CloudUsageReport> {
        const period = utcMonthPeriod(now);
        const local = this.meter.r2Month(now);
        const account = await this.r2Account(now, period, refresh);
        const elapsedDays = elapsedMonthDays(now, period);
        const remainingDays = Math.max(0, period.days - elapsedDays);

        const source: 'account' | 'local' = account.data ? 'account' : 'local';
        let storedBytes: number;
        let gbMonthSoFar: number;
        let classA: number;
        let classB: number;
        if (account.data) {
            const stats = r2StorageStats(account.data.samples, { startTs: period.startTs, now, backfill: account.data.truncated });
            storedBytes = stats.currentBytes;
            gbMonthSoFar = stats.gbMonthSoFar;
            classA = account.data.classA;
            classB = account.data.classB;
        } else {
            // Không có số liệu tài khoản: dung lượng Deplao đã đẩy lên, coi như không đổi từ đầu tháng.
            storedBytes = this.localStoredBytes();
            gbMonthSoFar = (storedBytes / BYTES_PER_GB) * elapsedDays / BILLING_PERIOD_DAYS;
            classA = local.classA;
            classB = local.classB;
        }
        const currentGb = storedBytes / BYTES_PER_GB;
        const projectedGbMonth = gbMonthSoFar + currentGb * remainingDays / BILLING_PERIOD_DAYS;
        const opsFraction = elapsedFraction(now, period, 1 / period.days);
        const projectedA = linearProjection(classA, opsFraction);
        const projectedB = linearProjection(classB, opsFraction);

        const meters: CloudUsageMeter[] = [
            {
                // GB-tháng (đơn vị tính tiền): used = dung lượng đang lưu (GB, như giữ cả tháng) so với 10 GB-tháng miễn phí,
                // projected = GB-tháng dự kiến của cả tháng; GB = 10⁹ byte (costModel.BYTES_PER_GB)
                id: 'r2Storage',
                unit: 'gbMonth',
                used: currentGb,
                limit: R2_PRICING.freeStorageGbMonth,
                projected: projectedGbMonth,
                costSoFar: r2StorageCostUsd(gbMonthSoFar),
                costProjected: r2StorageCostUsd(projectedGbMonth),
                source,
            },
            {
                id: 'r2ClassA',
                unit: 'ops',
                used: classA,
                limit: R2_PRICING.freeClassA,
                projected: projectedA,
                costSoFar: r2OpsCostUsd(classA, 'A'),
                costProjected: r2OpsCostUsd(projectedA, 'A'),
                source,
            },
            {
                id: 'r2ClassB',
                unit: 'ops',
                used: classB,
                limit: R2_PRICING.freeClassB,
                projected: projectedB,
                costSoFar: r2OpsCostUsd(classB, 'B'),
                costProjected: r2OpsCostUsd(projectedB, 'B'),
                source,
            },
            // Tải xuống từ R2 miễn phí — chỉ để biết, số của Deplao trên máy này.
            { id: 'r2Egress', unit: 'bytes', used: local.bytesDown, limit: null, projected: null, costSoFar: 0, costProjected: 0, source: 'local' },
        ];
        return {
            provider: 'r2',
            generatedAt: now,
            period: { kind: 'month', startTs: period.startTs, endTs: period.endTs },
            accountData: !!account.data,
            accountNote: account.data ? null : account.note,
            meters,
            cost: sumCost(meters),
        };
    }

    /** Số liệu toàn tài khoản (nhớ 10 phút; refresh ≥ 60 s). Không ném. */
    private async r2Account(now: number, period: MonthPeriod, refresh: boolean): Promise<AccountView> {
        let core: CloudflareCore;
        let accountId: string | null = null;
        let tokenId: string | null = null;
        try {
            core = this.deps.core();
            const conn = core.status();
            const s = this.settingsSnapshot(core);
            if (conn?.connected) accountId = conn.accountId || s?.accountId || null;
            tokenId = s?.tokenId || null;
        } catch (err) {
            return { data: null, note: r2NoteFailed(errText(err)) };
        }
        if (!accountId) return { data: null, note: R2_NOTE_NOT_CONNECTED };

        const key = `${accountId}|${tokenId || ''}|${period.key}`;
        const cached = this.account && this.account.key === key ? this.account : null;
        if (cached) {
            const age = now - cached.at;
            if (age >= 0 && age < (refresh ? ACCOUNT_REFRESH_MIN_MS : ACCOUNT_CACHE_MS)) return cached;
        }

        let promise: Promise<AccountEntry>;
        if (this.inflight && this.inflight.key === key) {
            promise = this.inflight.promise;
        } else {
            let api: CloudflareApi;
            try {
                api = core.api();
            } catch (err) {
                return cached ?? { data: null, note: r2NoteFailed(errText(err)) };
            }
            let budget = Infinity;
            try {
                if (typeof api.budgetRemaining === 'function') budget = Number(api.budgetRemaining());
            } catch { /* không đọc được → coi như còn */ }
            if (Number.isFinite(budget) && budget < MIN_API_BUDGET) {
                return cached ?? { data: null, note: r2NoteFailed('Deplao đang dùng hết lượt gọi Cloudflare, thử lại sau ít phút') };
            }
            promise = this.queryAccount(api, accountId, key, period, now);
        }
        const entry = await settleWithin(promise, ACCOUNT_WAIT_MS);
        if (entry) return entry;
        return cached ?? { data: null, note: r2NoteFailed('Cloudflare phản hồi quá lâu') };
    }

    private queryAccount(api: CloudflareApi, accountId: string, key: string, period: MonthPeriod, now: number): Promise<AccountEntry> {
        const range = { startTs: period.startTs, endTs: Math.min(now, period.endTs - 1000) };
        const promise: Promise<AccountEntry> = fetchR2Analytics(api, accountId, range)
            .then((res): AccountEntry => {
                // tsconfig strict:false không thu hẹp union theo `ok` (boolean) → thu hẹp bằng 'data' in res
                if ('data' in res) return { key, at: this.now(), data: res.data, note: null };
                this.log('warn', `[CloudUsage] không đọc được số liệu R2 từ Cloudflare${res.permission ? ' (thiếu quyền)' : ''}: ${res.reason}`);
                return { key, at: this.now(), data: null, note: res.permission ? R2_NOTE_NO_PERMISSION : r2NoteFailed(res.reason) };
            })
            .catch((err): AccountEntry => ({ key, at: this.now(), data: null, note: r2NoteFailed(errText(err)) }))
            .then(entry => {
                // Đã có truy vấn mới hơn (đổi tài khoản / token / tháng) thì giữ kết quả của truy vấn đó.
                if (!this.inflight || this.inflight.promise === promise) this.account = entry;
                return entry;
            })
            .finally(() => {
                if (this.inflight && this.inflight.promise === promise) this.inflight = null;
            });
        this.inflight = { key, promise };
        return promise;
    }

    // ── Google Drive ──

    private async googleReport(now: number, refresh: boolean): Promise<CloudUsageReport> {
        const period = pacificDayPeriod(now);
        const day = this.meter.googleDay(now);
        let gs = this.googleStatus();
        const quotaStale = !gs?.quota || !gs.checkedAt || now - gs.checkedAt >= GOOGLE_QUOTA_MAX_AGE_MS || now < gs.checkedAt;
        // Chưa có dung lượng lần nào (vừa mở app) → đọc một lần dù không bấm Cập nhật (about.get rẻ: 5 đơn vị)
        if (gs?.connected && (refresh ? quotaStale : !gs.quota)) {
            try {
                await settleWithin(Promise.resolve(this.deps.core().google.refresh()), GOOGLE_REFRESH_WAIT_MS);
            } catch (err) {
                this.log('warn', `[CloudUsage] không đọc lại được dung lượng Google: ${errText(err)}`);
            }
            gs = this.googleStatus() ?? gs;
        }
        const quota = gs?.quota ?? null;
        const meters: CloudUsageMeter[] = [];
        if (quota) {
            const limit = quota.limit === null || quota.limit === undefined ? null : finiteNonNegative(quota.limit);
            meters.push({
                id: 'gdriveStorage', unit: 'bytes', used: finiteNonNegative(quota.usage), limit,
                projected: null, costSoFar: 0, costProjected: 0, source: 'account',
            });
        }
        // Đầu ngày không nhân quá 24 lần.
        const fraction = elapsedFraction(now, period, 1 / 24);
        meters.push(
            {
                id: 'gdriveUnitsDay', unit: 'units', used: day.units, limit: GDRIVE_LIMITS.unitsPerDayPerProject,
                projected: linearProjection(day.units, fraction), costSoFar: 0, costProjected: 0, source: 'local',
            },
            {
                id: 'gdriveEgressDay', unit: 'bytes', used: day.bytesDown, limit: GDRIVE_LIMITS.egressBytesPerDayPerProject,
                projected: null, costSoFar: 0, costProjected: 0, source: 'local',
            },
            {
                id: 'gdriveUploadDay', unit: 'bytes', used: day.bytesUp, limit: GDRIVE_LIMITS.uploadBytesPerDayPerUser,
                projected: null, costSoFar: 0, costProjected: 0, source: 'local',
            },
        );
        return {
            provider: 'gdrive',
            generatedAt: now,
            period: { kind: 'day', startTs: period.startTs, endTs: period.endTs },
            accountData: !!quota,
            accountNote: !quota && gs && !gs.connected ? GOOGLE_NOTE_NOT_CONNECTED : GOOGLE_NOTE,
            meters,
            // Dưới ngưỡng ngày Google không tính phí (giá vượt ngưỡng chưa công bố) → chỉ hiện % ngưỡng.
            cost: { soFar: 0, projected: 0 },
            sharedProject: !gs?.customClient,
        };
    }

    private googleStatus(): GoogleDriveStatus | null {
        try {
            return this.deps.core().google.status() || null;
        } catch {
            return null;
        }
    }

    // ── chung ──

    /** Báo cáo rỗng khi lập báo cáo lỗi bất ngờ (report() không ném). */
    private emptyReport(provider: CloudStorageProvider, now: number, reason: string): CloudUsageReport {
        let period: { startTs: number; endTs: number } = { startTs: now, endTs: now };
        try {
            period = provider === 'gdrive' ? pacificDayPeriod(now) : utcMonthPeriod(now);
        } catch { /* giữ mặc định */ }
        return {
            provider,
            generatedAt: now,
            period: { kind: provider === 'gdrive' ? 'day' : 'month', startTs: period.startTs, endTs: period.endTs },
            accountData: false,
            accountNote: `Chưa tính được mức sử dụng (${reason}).`,
            meters: [],
            cost: { soFar: 0, projected: 0 },
            ...(provider === 'gdrive' ? { sharedProject: true } : {}),
        };
    }

    private settingsSnapshot(core: CloudflareCore): { accountId?: string | null; tokenId?: string | null } | null {
        try {
            const s: any = core.settings;
            if (typeof s?.peek === 'function') return s.peek();
            if (typeof s?.get === 'function') return s.get();
        } catch { /* bỏ qua */ }
        return null;
    }

    private localStoredBytes(): number {
        try {
            return finiteNonNegative(this.deps.localStoredBytes ? this.deps.localStoredBytes() : 0);
        } catch {
            return 0;
        }
    }

    private now(): number {
        try {
            const n = this.deps.now ? this.deps.now() : Date.now();
            return Number.isFinite(n) ? n : Date.now();
        } catch {
            return Date.now();
        }
    }

    private log(level: 'log' | 'warn', msg: string): void {
        try {
            if (this.deps.log) this.deps.log(level, msg);
            else if (level === 'warn') Logger.warn(msg);
            else Logger.log(msg);
        } catch { /* bỏ qua */ }
    }
}

/** Bộ đếm + báo cáo mức sử dụng. Không có tác dụng phụ lúc tạo. */
export function createCloudUsage(deps: CloudUsageDeps): CloudUsageModule {
    return new CloudUsage(deps);
}
