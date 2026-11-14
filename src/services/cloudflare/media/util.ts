/**
 * Shared helpers for the R2 media module: default options, wait / wake-up, R2 error classification, streaming sha256 hashing,
 * free disk space, the night window, bandwidth limit. No dependency on Electron / DB (testable on its own).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ALL_SCOPE, CloudScope, MediaSyncOptions, normalizeScope, sameScope } from '../../../shared/cloud/cloudContracts';
import { tr } from '../../../shared/i18n';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const GIB = 1024 * 1024 * 1024;

export type LogFn = (level: 'log' | 'warn' | 'error', message: string) => void;
export const noLog: LogFn = () => { /* silent */ };

// ─── Options ────────────────────────────────────────────────────────────────

export const DEFAULT_MEDIA_OPTIONS: MediaSyncOptions = {
    concurrency: 3,
    nightOnly: false,
    bandwidthKbps: 0,
    evictEnabled: false,
    evictKeepDays: 30,
    evictMinFreeGb: 20,
    scope: { ...ALL_SCOPE },
    includeShared: true,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** Normalizes options (unknown values → default, clamped to the valid range). */
export function normalizeMediaOptions(input?: Partial<MediaSyncOptions> | null): MediaSyncOptions {
    const o: Partial<MediaSyncOptions> = input && typeof input === 'object' ? input : {};
    const minFree = Number(o.evictMinFreeGb);
    return {
        concurrency: clampInt(o.concurrency, DEFAULT_MEDIA_OPTIONS.concurrency, 1, 16),
        nightOnly: typeof o.nightOnly === 'boolean' ? o.nightOnly : DEFAULT_MEDIA_OPTIONS.nightOnly,
        bandwidthKbps: clampInt(o.bandwidthKbps, DEFAULT_MEDIA_OPTIONS.bandwidthKbps, 0, 10_000_000),
        evictEnabled: o.evictEnabled === true,
        evictKeepDays: clampInt(o.evictKeepDays, DEFAULT_MEDIA_OPTIONS.evictKeepDays, 1, 3650),
        evictMinFreeGb: Number.isFinite(minFree)
            ? Math.min(100_000, Math.max(0, Math.round(minFree * 10) / 10))
            : DEFAULT_MEDIA_OPTIONS.evictMinFreeGb,
        // Missing / wrong type → all accounts, all time, with shared files (as before scopes existed)
        scope: normalizeScope(o.scope),
        includeShared: typeof o.includeShared === 'boolean' ? o.includeShared : true,
    };
}

/** Storage scope (missing = all). */
export function mediaScopeOf(o: Partial<MediaSyncOptions> | null | undefined): CloudScope {
    return o && o.scope ? o.scope : ALL_SCOPE;
}

/** Whether files that belong to no account are stored (missing = yes). */
export function includeSharedOf(o: Partial<MediaSyncOptions> | null | undefined): boolean {
    return !o || o.includeShared !== false;
}

/** Two option sets with the same storage scope (accounts, from date, shared files). */
export function sameMediaScope(a: Partial<MediaSyncOptions> | null | undefined, b: Partial<MediaSyncOptions> | null | undefined): boolean {
    return includeSharedOf(a) === includeSharedOf(b) && sameScope(mediaScopeOf(a), mediaScopeOf(b));
}

/** Deep copy (the accounts array does not share a reference with the copy being held). */
export function cloneMediaOptions(o: MediaSyncOptions): MediaSyncOptions {
    const scope = mediaScopeOf(o);
    return {
        ...o,
        scope: { accounts: scope.accounts === 'all' ? 'all' : [...scope.accounts], fromTs: scope.fromTs },
        includeShared: includeSharedOf(o),
    };
}

// ─── Timers ─────────────────────────────────────────────────────────────────

export function unrefTimer(timer: unknown): void {
    try { (timer as { unref?: () => void })?.unref?.(); } catch { /* ignore */ }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => unrefTimer(setTimeout(resolve, Math.max(0, ms))));
}

/** Yields to the event loop (between folders / batches) so the main thread is not blocked. */
export function yieldToLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

export interface Waiter {
    /** Waits up to ms, or until wake(). */
    wait(ms: number): Promise<void>;
    wake(): void;
}

/** A wait that can be woken early (resume, option change, new file, a download run finished…). */
export class Waker implements Waiter {
    private readonly waiters = new Set<() => void>();

    wait(ms: number): Promise<void> {
        return new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const done = () => {
                if (timer) clearTimeout(timer);
                this.waiters.delete(done);
                resolve();
            };
            this.waiters.add(done);
            timer = setTimeout(done, Math.max(0, ms));
            unrefTimer(timer);
        });
    }

    wake(): void {
        for (const done of Array.from(this.waiters)) done();
    }
}

/** Promise with a deadline: when it expires → returns the fallback (the original promise keeps running, it is not cancelled). */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
        unrefTimer(timer);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(fallback); },
        );
    });
}

/** Night window 22:00 to 07:00 (machine time). 0 = inside the window; > 0 = ms until 22:00 today. */
export function msUntilNightWindow(now: number): number {
    const d = new Date(now);
    const h = d.getHours();
    if (h >= 22 || h < 7) return 0;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 22, 0, 0, 0).getTime();
    return Math.max(SECOND, start - now);
}

/** ms until the next time the machine clock shows hour:minute (always > 0). */
export function msUntilLocalTime(now: number, hour: number, minute = 0): number {
    const d = new Date(now);
    let target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
    if (target <= now) target = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, minute, 0, 0).getTime();
    return Math.max(SECOND, target - now);
}

// ─── Bandwidth limit ─────────────────────────────────────────────────────

/**
 * Byte-based token bucket. kbps = kilobits/second (0 = no limit). putFile of R2Client reads the file itself (it does not take a
 * stream), so it cannot be throttled midway: bytes sent (onProgress) are subtracted from the bucket, a negative bucket = "nợ" (debt) → the next
 * transfer must wait until the debt is paid off. The average speed matches the limit; a single file may still run faster while it is being sent.
 */
export class ByteRateLimiter {
    private tokens = 0;
    private last: number;
    private kbps: number;

    constructor(kbps: number, private readonly now: () => number = Date.now) {
        this.kbps = Math.max(0, Number(kbps) || 0);
        this.last = now();
    }

    setKbps(kbps: number): void {
        const next = Math.max(0, Number(kbps) || 0);
        if (next === this.kbps) return;
        this.refill();
        this.kbps = next;
        if (!next) this.tokens = 0;
    }

    /** bytes / second */
    private get rate(): number {
        return (this.kbps * 1000) / 8;
    }

    private refill(): void {
        const t = this.now();
        const dt = Math.max(0, t - this.last) / 1000;
        this.last = t;
        if (!this.kbps) return;
        // Accumulate at most 1 second of budget while idle, to avoid a burst after a long pause
        this.tokens = Math.min(this.rate, this.tokens + dt * this.rate);
    }

    consume(bytes: number): void {
        if (!this.kbps || !(bytes > 0)) return;
        this.refill();
        this.tokens -= bytes;
    }

    /** ms to wait before starting the next transfer (0 = may start now). */
    waitMs(): number {
        if (!this.kbps) return 0;
        this.refill();
        return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
    }
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/** Name of the selected store used in messages ("R2" / "Google Drive"), see ../storeLabel. */
export { storeLabelNow } from '../storeLabel';

// ─── R2 errors ──────────────────────────────────────────────────────────────────

/**
 * busy    : 429 / 5xx (CloudError 'R2_BUSY'): the whole queue backs off.
 * network : no network / timed out: the whole queue backs off.
 * auth    : wrong token / missing permission / not connected: stop the queue, notify the user.
 * bucket  : the bucket no longer exists: stop the queue, notify the user.
 * other   : an error for one file only (reading the file, size mismatch…): retry that file later.
 */
export type R2ErrorKind = 'busy' | 'network' | 'auth' | 'bucket' | 'other';

const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|EPIPE|ERR_SOCKET_[A-Z_]+|UND_ERR_[A-Z_]+|ERR_STREAM_PREMATURE_CLOSE)$/;

export function classifyR2Error(err: unknown): R2ErrorKind {
    const e = (err || {}) as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
    const code = String(e.code ?? '');
    const status = Number(e.status ?? e.statusCode ?? 0) || 0;
    const message = String(e.message ?? '');
    if (code === 'R2_BUSY' || code === 'RATE_LIMITED' || status === 429 || status >= 500) return 'busy';
    // R2_NOT_ENABLED / R2_CLOCK_SKEW: the user must fix it (turn on R2, correct the machine clock) → stop like a permission error
    if (code === 'NOT_CONNECTED' || code === 'R2_NOT_ENABLED' || code === 'R2_CLOCK_SKEW' || status === 401 || status === 403
        || /AUTH|FORBIDDEN|PERMISSION|DENIED|UNAUTHORI[SZ]ED|INVALID_?TOKEN|TOKEN_|SIGNATURE|CREDENTIAL|ACCESS_?KEY/i.test(code)) return 'auth';
    // Only "bucket không còn" (bucket gone) stops the whole queue; other 404s (R2_NO_UPLOAD, R2_NOT_FOUND) are errors for one file only
    if (code === 'R2_NO_BUCKET' || /NO_?SUCH_?BUCKET|BUCKET_?NOT_?FOUND/i.test(code) || /NoSuchBucket/i.test(message)) return 'bucket';
    if (NETWORK_CODES.test(code) || /NETWORK|TIMEOUT|TIMED_?OUT/i.test(code) || /socket hang up|network|timed? ?out/i.test(message)) return 'network';
    return 'other';
}

export function errorText(err: unknown): string {
    const msg = (err as { message?: unknown })?.message ?? err ?? tr('Lỗi không xác định');
    return String(msg).slice(0, 300);
}

// ─── Files / disk ────────────────────────────────────────────────────────────

/** sha256 (hex) read as a stream in 1 MiB blocks (the whole file is not loaded into RAM). */
export function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

/** Free space (bytes) of the drive holding dir; null if it cannot be read (fs.statfs missing / failed). */
export async function freeDiskBytes(dir: string): Promise<number | null> {
    try {
        const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> }).statfs;
        if (typeof statfs !== 'function') return null;
        const s = await statfs(dir);
        const free = Number(s.bavail) * Number(s.bsize);
        return Number.isFinite(free) && free >= 0 ? free : null;
    } catch {
        return null;
    }
}
