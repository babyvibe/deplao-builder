/**
 * RequestLog — nhật ký request API, ghi theo lô (2 giây hoặc 100 dòng) trong một
 * transaction để không chặn main thread. Không ghi body/query (tránh lộ dữ liệu).
 */
import { apiDb } from '../dbSchema';
import { getApiSettingNumber } from '../settings';

export interface RequestLogRow {
    principal_id: string;
    method: string;
    route: string;
    status: number;
    took_ms: number;
    ip: string;
    request_id: string;
    error_code: string | null;
    created_at: number;
}

const FLUSH_MS = 2000;
const FLUSH_ROWS = 100;
const MAX_BUFFER = 5000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export class RequestLog {
    private buffer: RequestLogRow[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastPrune = 0;
    /** Bộ đếm trong bộ nhớ cho tab giám sát (không cần query DB). */
    private recent: Array<{ at: number; status: number; ms: number }> = [];

    record(row: RequestLogRow): void {
        this.recent.push({ at: row.created_at, status: row.status, ms: row.took_ms });
        if (this.recent.length > 2000) this.recent.splice(0, this.recent.length - 2000);
        if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
        this.buffer.push(row);
        if (this.buffer.length >= FLUSH_ROWS) {
            this.flush();
            return;
        }
        if (!this.timer) {
            this.timer = setTimeout(() => this.flush(), FLUSH_MS);
            if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref();
        }
    }

    flush(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.buffer.length === 0) return;
        const rows = this.buffer;
        this.buffer = [];
        try {
            const db = apiDb();
            db.transaction(() => {
                for (const r of rows) {
                    db.run(
                        `INSERT INTO api_request_logs (principal_id, method, route, status, took_ms, ip, request_id, error_code, created_at)
                         VALUES (?,?,?,?,?,?,?,?,?)`,
                        [r.principal_id, r.method, r.route, r.status, r.took_ms, r.ip, r.request_id, r.error_code, r.created_at],
                    );
                }
            });
        } catch {
            /* Ghi log thất bại không được ảnh hưởng request. */
        }
        this.maybePrune();
    }

    private maybePrune(now = Date.now()): void {
        if (now - this.lastPrune < PRUNE_EVERY_MS) return;
        this.lastPrune = now;
        const days = Math.max(1, getApiSettingNumber('api_request_log_days') || 7);
        try {
            apiDb().run('DELETE FROM api_request_logs WHERE created_at < ?', [now - days * 86_400_000]);
        } catch { /* ignore */ }
    }

    /** Thống kê theo principal trong N giờ gần nhất. */
    usage(principalId: string, hours = 24): { total: number; errors: number; last_at: number | null; by_status: Record<string, number> } {
        this.flush();
        const since = Date.now() - hours * 3600_000;
        try {
            const rows = apiDb().query<{ status: number; n: number; last_at: number }>(
                `SELECT status, COUNT(*) AS n, MAX(created_at) AS last_at FROM api_request_logs
                 WHERE principal_id = ? AND created_at >= ? GROUP BY status`,
                [principalId, since],
            );
            const byStatus: Record<string, number> = {};
            let total = 0;
            let errors = 0;
            let lastAt: number | null = null;
            for (const r of rows) {
                byStatus[String(r.status)] = Number(r.n);
                total += Number(r.n);
                if (r.status >= 400) errors += Number(r.n);
                lastAt = Math.max(lastAt || 0, Number(r.last_at) || 0) || lastAt;
            }
            return { total, errors, last_at: lastAt, by_status: byStatus };
        } catch {
            return { total: 0, errors: 0, last_at: null, by_status: {} };
        }
    }

    latest(limit = 100, principalId?: string): any[] {
        this.flush();
        try {
            const lim = Math.min(Math.max(1, limit), 500);
            if (principalId) {
                return apiDb().query('SELECT * FROM api_request_logs WHERE principal_id = ? ORDER BY id DESC LIMIT ?', [principalId, lim]);
            }
            return apiDb().query('SELECT * FROM api_request_logs ORDER BY id DESC LIMIT ?', [lim]);
        } catch {
            return [];
        }
    }

    /** Chỉ số 5 phút gần nhất (tab giám sát). */
    metrics(now = Date.now()): { requests_per_min: number; p95_ms: number; errors_5xx: number; window_sec: number } {
        const windowMs = 5 * 60_000;
        const rows = this.recent.filter(r => now - r.at <= windowMs);
        const sorted = rows.map(r => r.ms).sort((a, b) => a - b);
        const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
        return {
            requests_per_min: Math.round((rows.length / 5) * 10) / 10,
            p95_ms: p95,
            errors_5xx: rows.filter(r => r.status >= 500).length,
            window_sec: windowMs / 1000,
        };
    }
}
