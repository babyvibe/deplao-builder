/**
 * UsageMeter — bộ đếm thao tác của Deplao trên MÁY NÀY: userData/cloud-usage.json.
 *
 *  - R2 theo tháng UTC ('YYYY-MM' — kỳ tính tiền của Cloudflare): Class A / B / miễn phí + byte lên / xuống; giữ 3 tháng
 *    gần nhất.
 *  - Google Drive theo ngày giờ Thái Bình Dương ('YYYY-MM-DD' — hạn mức ngày của Google đặt lại lúc 0:00 giờ LA): đơn vị
 *    quota, số request, byte lên / xuống; giữ 40 ngày.
 *  - Đường nóng (sau mỗi request R2 / Drive): O(1), không ném. File đọc lần đầu cần tới (không đọc lúc tạo); ghi gộp
 *    ~15 s một lần (file tạm + rename; lỗi ghi bỏ qua, lần sau thử lại). flush() ghi ngay (lúc thoát app).
 *  - File hỏng / thiếu → đếm lại từ 0. Không xác định được đường dẫn (chưa có electron…) → chỉ đếm trong RAM.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { R2OpClass } from '../contracts';
import { pacificDayKey, pacificDayPeriod, shiftDayKey, shiftMonthKey, utcMonthKey, utcMonthPeriod } from './costModel';

export interface R2MonthCounters {
    classA: number;
    classB: number;
    free: number;
    bytesUp: number;
    bytesDown: number;
}

export interface GoogleDayCounters {
    /** Đơn vị quota Drive API (5 / 50 / 100 / 200 mỗi request). */
    units: number;
    requests: number;
    bytesUp: number;
    bytesDown: number;
}

export interface UsageFileData {
    version: 1;
    /** Khoá 'YYYY-MM' (tháng UTC). */
    r2: Record<string, R2MonthCounters>;
    /** Khoá 'YYYY-MM-DD' (ngày giờ Thái Bình Dương). */
    google: Record<string, GoogleDayCounters>;
}

export const R2_KEEP_MONTHS = 3;
export const GOOGLE_KEEP_DAYS = 40;
export const USAGE_SAVE_DELAY_MS = 15_000;

export interface UsageMeterOptions {
    /** Đường dẫn file (gọi muộn, lần đầu cần đọc / ghi). Ném → chỉ đếm trong RAM. */
    filePath: () => string;
    now?: () => number;
    log?: (level: 'log' | 'warn', msg: string) => void;
    /** Ghi gộp sau bấy nhiêu ms kể từ thay đổi đầu tiên chưa ghi (mặc định 15 s). */
    saveDelayMs?: number;
}

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyR2(): R2MonthCounters {
    return { classA: 0, classB: 0, free: 0, bytesUp: 0, bytesDown: 0 };
}

function emptyGoogle(): GoogleDayCounters {
    return { units: 0, requests: 0, bytesUp: 0, bytesDown: 0 };
}

/** Số dương hữu hạn, còn lại = 0. */
function positive(n: unknown): number {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function isObj(v: unknown): v is Record<string, any> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Chuẩn hoá nội dung file (sai kiểu / khoá lạ → bỏ). */
export function normalizeUsageFile(raw: unknown): UsageFileData {
    const out: UsageFileData = { version: 1, r2: {}, google: {} };
    if (!isObj(raw)) return out;
    if (isObj(raw.r2)) {
        for (const [key, v] of Object.entries(raw.r2)) {
            if (!MONTH_KEY_RE.test(key) || !isObj(v)) continue;
            out.r2[key] = {
                classA: positive(v.classA), classB: positive(v.classB), free: positive(v.free),
                bytesUp: positive(v.bytesUp), bytesDown: positive(v.bytesDown),
            };
        }
    }
    if (isObj(raw.google)) {
        for (const [key, v] of Object.entries(raw.google)) {
            if (!DAY_KEY_RE.test(key) || !isObj(v)) continue;
            out.google[key] = {
                units: positive(v.units), requests: positive(v.requests),
                bytesUp: positive(v.bytesUp), bytesDown: positive(v.bytesDown),
            };
        }
    }
    return out;
}

interface Slot<T> { startTs: number; endTs: number; counters: T }

export class UsageMeter {
    private data: UsageFileData | null = null;
    /** undefined = chưa xác định; null = không có nơi lưu (chỉ RAM). */
    private file: string | null | undefined = undefined;
    private dirty = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** Kỳ hiện tại + bộ đếm của nó: đường nóng chỉ so thời điểm, không tính lại khoá. */
    private r2Slot: Slot<R2MonthCounters> | null = null;
    private googleSlot: Slot<GoogleDayCounters> | null = null;
    private writeErrorLogged = false;

    constructor(private readonly opts: UsageMeterOptions) {}

    /** Một request R2 đã tới R2 (kể cả trả lỗi). Loại lạ → Class A (không thấp). */
    recordR2(op: R2OpClass, up?: number, down?: number): void {
        const c = this.r2Current();
        if (op === 'B') c.classB += 1;
        else if (op === 'free') c.free += 1;
        else c.classA += 1;
        c.bytesUp += positive(up);
        c.bytesDown += positive(down);
        this.touch();
    }

    /** Một request Drive API: units = đơn vị quota của request. */
    recordGoogle(units: number, up?: number, down?: number): void {
        const c = this.googleCurrent();
        c.units += positive(units);
        c.requests += 1;
        c.bytesUp += positive(up);
        c.bytesDown += positive(down);
        this.touch();
    }

    /** Số đếm R2 của tháng UTC chứa ts (bản sao). */
    r2Month(ts: number = this.now()): R2MonthCounters {
        const c = this.load().r2[utcMonthKey(ts)];
        return c ? { ...c } : emptyR2();
    }

    /** Số đếm Google của ngày giờ Thái Bình Dương chứa ts (bản sao). */
    googleDay(ts: number = this.now()): GoogleDayCounters {
        const c = this.load().google[pacificDayKey(ts)];
        return c ? { ...c } : emptyGoogle();
    }

    /** Ghi xuống đĩa ngay (đồng bộ) nếu có thay đổi chưa ghi. */
    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.dirty || !this.data) return;
        this.write();
    }

    // ── nội bộ ──

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    private log(level: 'log' | 'warn', msg: string): void {
        try {
            this.opts.log?.(level, msg);
        } catch { /* bỏ qua */ }
    }

    private r2Current(): R2MonthCounters {
        const now = this.now();
        const slot = this.r2Slot;
        if (slot && now >= slot.startTs && now < slot.endTs) return slot.counters;
        const data = this.load();
        const p = utcMonthPeriod(now);
        let c = data.r2[p.key];
        if (!c) {
            c = emptyR2();
            data.r2[p.key] = c;
        }
        this.r2Slot = { startTs: p.startTs, endTs: p.endTs, counters: c };
        this.prune(now);
        return c;
    }

    private googleCurrent(): GoogleDayCounters {
        const now = this.now();
        const slot = this.googleSlot;
        if (slot && now >= slot.startTs && now < slot.endTs) return slot.counters;
        const data = this.load();
        const p = pacificDayPeriod(now);
        let c = data.google[p.key];
        if (!c) {
            c = emptyGoogle();
            data.google[p.key] = c;
        }
        this.googleSlot = { startTs: p.startTs, endTs: p.endTs, counters: c };
        this.prune(now);
        return c;
    }

    /** Bỏ tháng R2 cũ hơn 3 tháng gần nhất và ngày Google cũ hơn 40 ngày (khoá dạng chuỗi so sánh được). */
    private prune(now: number): void {
        const d = this.data;
        if (!d) return;
        const r2Cut = shiftMonthKey(utcMonthKey(now), -(R2_KEEP_MONTHS - 1));
        for (const key of Object.keys(d.r2)) {
            if (key < r2Cut) {
                if (this.r2Slot?.counters === d.r2[key]) this.r2Slot = null;
                delete d.r2[key];
                this.dirty = true;
            }
        }
        const googleCut = shiftDayKey(pacificDayKey(now), -(GOOGLE_KEEP_DAYS - 1));
        for (const key of Object.keys(d.google)) {
            if (key < googleCut) {
                if (this.googleSlot?.counters === d.google[key]) this.googleSlot = null;
                delete d.google[key];
                this.dirty = true;
            }
        }
    }

    private resolveFile(): string | null {
        if (this.file !== undefined) return this.file;
        try {
            const f = this.opts.filePath();
            this.file = typeof f === 'string' && f ? f : null;
        } catch (err: any) {
            this.file = null;
            this.log('warn', `[CloudUsage] không xác định được nơi lưu bộ đếm (${err?.message || err}) — chỉ đếm trong RAM`);
        }
        return this.file;
    }

    private load(): UsageFileData {
        if (this.data) return this.data;
        let raw: unknown = null;
        const file = this.resolveFile();
        if (file) {
            try {
                raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (err: any) {
                if (err?.code !== 'ENOENT') {
                    this.log('warn', `[CloudUsage] ${path.basename(file)} hỏng / không đọc được (${err?.code || err?.message || err}) — đếm lại từ 0`);
                }
            }
        }
        this.data = normalizeUsageFile(raw);
        this.prune(this.now());
        return this.data;
    }

    /** Ghi gộp: hẹn một lần ghi sau saveDelayMs kể từ thay đổi đầu tiên (lưu lượng đều cũng không hoãn mãi). */
    private touch(): void {
        this.dirty = true;
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            try {
                this.flush();
            } catch { /* bỏ qua */ }
        }, this.opts.saveDelayMs ?? USAGE_SAVE_DELAY_MS);
        (this.timer as any)?.unref?.();
    }

    private write(): void {
        const file = this.resolveFile();
        if (!file || !this.data) {
            this.dirty = false; // chỉ RAM
            return;
        }
        const tmp = `${file}.tmp-${process.pid}`;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
            fs.renameSync(tmp, file);
            this.dirty = false;
            this.writeErrorLogged = false;
        } catch (err: any) {
            try { fs.unlinkSync(tmp); } catch { /* bỏ qua */ }
            // dirty giữ nguyên → lần ghi sau thử lại; log một lần cho tới khi ghi được.
            if (!this.writeErrorLogged) {
                this.writeErrorLogged = true;
                this.log('warn', `[CloudUsage] chưa ghi được ${path.basename(file)} (${err?.code || err?.message || err}) — sẽ thử lại`);
            }
        }
    }
}
