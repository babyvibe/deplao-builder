/**
 * UsageMeter: Deplao's operation counter on THIS machine: userData/cloud-usage.json.
 *
 *  - R2 per UTC month ('YYYY-MM': Cloudflare's billing period): Class A / B / free + bytes up / down; keeps the 3 most recent months.
 *  - Google Drive per Pacific-time day ('YYYY-MM-DD': Google's daily quota resets at 00:00 LA time): quota units,
 *    request count, bytes up / down; keeps 40 days.
 *  - Hot path (after every R2 / Drive request): O(1), never throws. The file is read the first time it is needed (not at creation); writes are batched
 *    about every 15 s (temp file + rename; a failed write is ignored and retried next time). flush() writes at once (when the app quits).
 *  - Broken / missing file → count again from 0. Path cannot be determined (electron not ready yet…) → count in RAM only.
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
    /** Drive API quota units (5 / 50 / 100 / 200 per request). */
    units: number;
    requests: number;
    bytesUp: number;
    bytesDown: number;
}

export interface UsageFileData {
    version: 1;
    /** Key 'YYYY-MM' (UTC month). */
    r2: Record<string, R2MonthCounters>;
    /** Key 'YYYY-MM-DD' (Pacific-time day). */
    google: Record<string, GoogleDayCounters>;
}

export const R2_KEEP_MONTHS = 3;
export const GOOGLE_KEEP_DAYS = 40;
export const USAGE_SAVE_DELAY_MS = 15_000;

export interface UsageMeterOptions {
    /** File path (called late; the first time it is needed, read / write). Throws → count in RAM only. */
    filePath: () => string;
    now?: () => number;
    log?: (level: 'log' | 'warn', msg: string) => void;
    /** Batched write this many ms after the first change not yet written (default 15 s). */
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

/** A finite positive number, otherwise 0. */
function positive(n: unknown): number {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function isObj(v: unknown): v is Record<string, any> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Normalizes the file content (wrong type / unknown key → dropped). */
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
    /** undefined = not determined yet; null = no place to store it (RAM only). */
    private file: string | null | undefined = undefined;
    private dirty = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** Current period + its counters: the hot path only compares the time, it does not recompute the keys. */
    private r2Slot: Slot<R2MonthCounters> | null = null;
    private googleSlot: Slot<GoogleDayCounters> | null = null;
    private writeErrorLogged = false;

    constructor(private readonly opts: UsageMeterOptions) {}

    /** One R2 request that reached R2 (including error responses). Unknown kind → Class A (not low). */
    recordR2(op: R2OpClass, up?: number, down?: number): void {
        const c = this.r2Current();
        if (op === 'B') c.classB += 1;
        else if (op === 'free') c.free += 1;
        else c.classA += 1;
        c.bytesUp += positive(up);
        c.bytesDown += positive(down);
        this.touch();
    }

    /** One Drive API request: units = the quota units of the request. */
    recordGoogle(units: number, up?: number, down?: number): void {
        const c = this.googleCurrent();
        c.units += positive(units);
        c.requests += 1;
        c.bytesUp += positive(up);
        c.bytesDown += positive(down);
        this.touch();
    }

    /** R2 counters of the UTC month containing ts (a copy). */
    r2Month(ts: number = this.now()): R2MonthCounters {
        const c = this.load().r2[utcMonthKey(ts)];
        return c ? { ...c } : emptyR2();
    }

    /** Google counters of the Pacific-time day containing ts (a copy). */
    googleDay(ts: number = this.now()): GoogleDayCounters {
        const c = this.load().google[pacificDayKey(ts)];
        return c ? { ...c } : emptyGoogle();
    }

    /** Writes to disk at once (synchronously) if there are unwritten changes. */
    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.dirty || !this.data) return;
        this.write();
    }

    // ── internal ──

    private now(): number {
        return this.opts.now ? this.opts.now() : Date.now();
    }

    private log(level: 'log' | 'warn', msg: string): void {
        try {
            this.opts.log?.(level, msg);
        } catch { /* ignore */ }
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

    /** Drops R2 months older than the 3 most recent and Google days older than 40 days (keys as comparable strings). */
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

    /** Batched write: schedules one write saveDelayMs after the first unwritten change (steady traffic does not postpone it forever either). */
    private touch(): void {
        this.dirty = true;
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            try {
                this.flush();
            } catch { /* ignore */ }
        }, this.opts.saveDelayMs ?? USAGE_SAVE_DELAY_MS);
        (this.timer as any)?.unref?.();
    }

    private write(): void {
        const file = this.resolveFile();
        if (!file || !this.data) {
            this.dirty = false; // RAM only
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
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            // dirty stays → the next write retries it; log once until a write succeeds.
            if (!this.writeErrorLogged) {
                this.writeErrorLogged = true;
                this.log('warn', `[CloudUsage] chưa ghi được ${path.basename(file)} (${err?.code || err?.message || err}) — sẽ thử lại`);
            }
        }
    }
}
