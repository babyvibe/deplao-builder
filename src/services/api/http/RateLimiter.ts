/**
 * RateLimiter — token bucket theo principal. CHỈ chạy khi khách tự đặt giới hạn > 0
 * (cho key, hoặc mặc định toàn cục). Mặc định không giới hạn.
 *
 * BruteForceGuard — tạm chặn IP gửi quá nhiều key sai. Key hợp lệ luôn đi qua.
 */

interface Bucket { tokens: number; updatedAt: number; limit: number; }

export class RateLimiter {
    private buckets = new Map<string, Bucket>();

    /** limitPerMin <= 0 → luôn cho qua. Trả số giây cần chờ khi vượt (0 = được phép). */
    take(id: string, limitPerMin: number, now = Date.now()): { allowed: boolean; retryAfterSec: number; remaining: number; limit: number } {
        if (!limitPerMin || limitPerMin <= 0) return { allowed: true, retryAfterSec: 0, remaining: -1, limit: 0 };
        let b = this.buckets.get(id);
        if (!b || b.limit !== limitPerMin) {
            b = { tokens: limitPerMin, updatedAt: now, limit: limitPerMin };
            this.buckets.set(id, b);
        }
        const refillPerMs = limitPerMin / 60_000;
        b.tokens = Math.min(limitPerMin, b.tokens + (now - b.updatedAt) * refillPerMs);
        b.updatedAt = now;
        if (b.tokens >= 1) {
            b.tokens -= 1;
            return { allowed: true, retryAfterSec: 0, remaining: Math.floor(b.tokens), limit: limitPerMin };
        }
        const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
        if (this.buckets.size > 10_000) this.prune(now);
        return { allowed: false, retryAfterSec, remaining: 0, limit: limitPerMin };
    }

    private prune(now: number): void {
        for (const [id, b] of this.buckets) {
            if (now - b.updatedAt > 10 * 60_000) this.buckets.delete(id);
        }
    }

    reset(): void {
        this.buckets.clear();
    }
}

export class BruteForceGuard {
    private failures = new Map<string, { count: number; windowStart: number; blockedUntil: number }>();

    constructor(
        private readonly maxFailuresPerMinute = 20,
        private readonly blockMs = 10 * 60_000,
    ) {}

    isBlocked(ip: string, now = Date.now()): boolean {
        const f = this.failures.get(ip);
        return !!f && f.blockedUntil > now;
    }

    recordFailure(ip: string, now = Date.now()): void {
        if (!ip) return;
        let f = this.failures.get(ip);
        if (!f || now - f.windowStart > 60_000) {
            f = { count: 0, windowStart: now, blockedUntil: f?.blockedUntil || 0 };
            this.failures.set(ip, f);
        }
        f.count += 1;
        if (f.count >= this.maxFailuresPerMinute) f.blockedUntil = now + this.blockMs;
        if (this.failures.size > 10_000) {
            for (const [k, v] of this.failures) {
                if (v.blockedUntil < now && now - v.windowStart > 60_000) this.failures.delete(k);
            }
        }
    }

    blockedIps(now = Date.now()): Array<{ ip: string; until: number }> {
        const out: Array<{ ip: string; until: number }> = [];
        for (const [ip, f] of this.failures) if (f.blockedUntil > now) out.push({ ip, until: f.blockedUntil });
        return out;
    }

    reset(): void {
        this.failures.clear();
    }
}
