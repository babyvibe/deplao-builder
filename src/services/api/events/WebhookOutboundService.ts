/**
 * WebhookOutboundService — gửi sự kiện tới URL của bạn, có chữ ký HMAC, retry, dead-letter.
 *
 * Giao thức:
 *   POST <url>   Content-Type: application/json   body = envelope sự kiện
 *   X-Deplao-Event: <type>   X-Deplao-Delivery: <id>   X-Deplao-Timestamp: <giây>
 *   X-Deplao-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>
 * Thành công = 2xx trong 10 giây (redirect không được đi theo).
 * Thử lại sau 30 s, 2 phút, 10 phút, 1 giờ, 6 giờ (tổng 6 lần) → failed (dead-letter).
 * 100 lần thất bại liên tiếp → tự tắt subscription.
 *
 * Hàng đợi: mỗi URL gửi tuần tự (giữ thứ tự gần đúng, không dồn dập bên nhận), tối đa
 * CONCURRENCY URL song song → một URL chậm/chết không làm trễ URL khác.
 *
 * Mạng nội bộ: webhook chỉ được trỏ vào 127.x / 192.168.x / 10.x… khi được tạo từ chính máy
 * (allow_private = 1) hoặc người dùng bật api_allow_private_urls. Kiểm tra lúc kết nối (netGuard).
 */
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { apiDb, apiTablesExist } from '../dbSchema';
import { ApiError, Principal } from '../types';
import { EventHub, ApiEvent, canReceive } from './EventHub';
import { getApiSettingBool } from '../settings';
import { guardedRequest } from '../netGuard';
import { decryptSecret, encryptSecret } from '../secretBox';

export const RETRY_SCHEDULE_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
/** Lần đầu + 5 lần thử lại. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;
export const DISABLE_AFTER_FAILURES = 100;
const TIMEOUT_MS = 10_000;
const TICK_MS = 5_000;
const CONCURRENCY = 4;
/** Sau ngần này lần gửi liên tục cho 1 URL thì nhường lượt cho URL khác. */
const PER_URL_BURST = 50;
const RESPONSE_BODY_MAX = 2048;

export interface WebhookSubscription {
    id: string;
    key_id: string | null;
    name: string;
    url: string;
    events: string[];
    account_ids: string[] | null;
    active: boolean;
    /** true = được gửi tới mạng nội bộ (tạo từ chính máy). */
    allow_private: boolean;
    consecutive_failures: number;
    disabled_reason: string | null;
    last_delivery_at: number | null;
    created_at: number;
    updated_at: number;
}

interface SubRow {
    id: string; key_id: string | null; name: string; url: string; secret: string; events_json: string;
    account_ids_json: string | null; active: number; allow_private: number; consecutive_failures: number;
    disabled_reason: string | null; last_delivery_at: number | null; created_at: number; updated_at: number;
}

interface DeliveryRow {
    id: string; subscription_id: string; event_seq: number; event_type: string; payload_json: string; attempt: number;
    status: string; response_status: number | null; response_body: string | null; error: string | null;
    next_retry_at: number | null; created_at: number; delivered_at: number | null;
}

type DueRow = DeliveryRow & { url: string; secret: string; allow_private: number };

export interface PostResult {
    ok: boolean;
    status: number | null;
    body: string;
    error: string | null;
}

export interface WebhookDeps {
    /** Principal của chủ subscription (null nếu key đã bị thu hồi/hết hạn). */
    principalForKey: (keyId: string) => Principal | null;
    /** Thay HTTP client (test). Mặc định guardedRequest (chặn mạng nội bộ). */
    requestImpl?: typeof guardedRequest;
    logError?: (msg: string) => void;
}

export function signPayload(secret: string, timestampSec: number, body: string): string {
    return 'v1=' + crypto.createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
}

/** Hàm mẫu cho bên nhận (cũng dùng trong test). */
export function verifySignature(secret: string, timestampSec: string | number, body: string, header: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
    if (Math.abs(nowSec - Number(timestampSec)) > toleranceSec) return false;
    const expected = signPayload(secret, Number(timestampSec), body);
    const a = Buffer.from(String(header || ''));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseList(raw: string | null): string[] | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.map(String) : null;
    } catch {
        return null;
    }
}

function toSub(row: SubRow): WebhookSubscription {
    return {
        id: row.id, key_id: row.key_id, name: row.name, url: row.url,
        events: parseList(row.events_json) || ['*'], account_ids: parseList(row.account_ids_json),
        active: !!row.active, allow_private: !!row.allow_private,
        consecutive_failures: Number(row.consecutive_failures) || 0,
        disabled_reason: row.disabled_reason, last_delivery_at: row.last_delivery_at,
        created_at: row.created_at, updated_at: row.updated_at,
    };
}

export function validateWebhookUrl(raw: string): string {
    let u: URL;
    try { u = new URL(raw); } catch { throw new ApiError(400, 'VALIDATION_ERROR', 'URL webhook không hợp lệ'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ApiError(400, 'VALIDATION_ERROR', 'Chỉ nhận http/https');
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    if (port < 1024 && port !== 80 && port !== 443) throw new ApiError(400, 'VALIDATION_ERROR', 'Cổng < 1024 chỉ cho 80/443');
    if (u.username || u.password) throw new ApiError(400, 'VALIDATION_ERROR', 'Không đặt user:pass trong URL; dùng secret để xác thực');
    u.hash = '';
    return u.toString();
}

function describeError(err: any): string {
    if (err?.code === 'PRIVATE_ADDRESS') return 'Đích thuộc mạng nội bộ — bị chặn (webhook tạo từ xa không được trỏ vào LAN/localhost; bật api_allow_private_urls nếu cần)';
    if (err?.code === 'TIMEOUT') return `Timeout ${TIMEOUT_MS / 1000}s`;
    return String(err?.message || err).slice(0, 500);
}

export class WebhookOutboundService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private unsubscribe: (() => void) | null = null;
    private running = false;
    private inflightUrls = new Set<string>();
    private active = 0;
    private idleWaiters: Array<() => void> = [];
    private deliveredCount = 0;
    private lastPrune = 0;
    private pumpScheduled = false;
    /** URL tạm nghỉ sau lỗi bất ngờ (DB không ghi được...) → không gửi trùng liên tục. */
    private cooldown = new Map<string, number>();

    constructor(private readonly hub: EventHub, private readonly deps: WebhookDeps) {}

    start(): void {
        if (this.running) return;
        this.running = true;
        this.unsubscribe = this.hub.subscribe({ principal: null, handler: e => this.enqueue(e) });
        this.timer = setInterval(() => this.pump(), TICK_MS);
        if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref();
    }

    stop(): void {
        this.running = false;
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // ─── CRUD ────────────────────────────────────────────────────────────

    list(keyId?: string | null): WebhookSubscription[] {
        const db = apiDb();
        const rows = keyId === undefined
            ? db.query<SubRow>('SELECT * FROM webhook_subscriptions ORDER BY created_at DESC')
            : db.query<SubRow>('SELECT * FROM webhook_subscriptions WHERE key_id IS ? ORDER BY created_at DESC', [keyId]);
        return rows.map(toSub);
    }

    get(id: string, keyId?: string | null): WebhookSubscription {
        const row = apiDb().queryOne<SubRow>('SELECT * FROM webhook_subscriptions WHERE id = ?', [id]);
        if (!row || (keyId !== undefined && row.key_id !== keyId)) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy webhook');
        return toSub(row);
    }

    create(input: {
        keyId: string | null; name?: string; url: string; events?: string[]; accountIds?: string[] | null; secret?: string;
        /** Người tạo gọi từ chính máy → được trỏ vào mạng nội bộ. */
        allowPrivate?: boolean;
    }): { subscription: WebhookSubscription; secret: string } {
        const url = validateWebhookUrl(input.url);
        const secret = input.secret && input.secret.length >= 16 ? input.secret : `whsec_${crypto.randomBytes(24).toString('base64url')}`;
        const id = `wh_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const now = Date.now();
        apiDb().run(
            `INSERT INTO webhook_subscriptions (id, key_id, name, url, secret, events_json, account_ids_json, active, allow_private, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,1,?,?,?)`,
            [id, input.keyId, String(input.name || '').slice(0, 100), url, encryptSecret(secret),
                JSON.stringify(input.events && input.events.length ? input.events : ['*']),
                input.accountIds && input.accountIds.length ? JSON.stringify(input.accountIds) : null,
                input.allowPrivate ? 1 : 0, now, now],
        );
        this.hub.invalidateConsumers();
        return { subscription: this.get(id), secret };
    }

    update(id: string, keyId: string | null | undefined, patch: {
        name?: string; url?: string; events?: string[]; accountIds?: string[] | null; active?: boolean;
        /** Chỉ áp dụng khi đổi URL: quyền trỏ vào mạng nội bộ của người sửa. */
        allowPrivate?: boolean;
    }): WebhookSubscription {
        this.get(id, keyId);
        const sets: string[] = [];
        const params: any[] = [];
        if (patch.name !== undefined) { sets.push('name = ?'); params.push(String(patch.name).slice(0, 100)); }
        if (patch.url !== undefined) {
            sets.push('url = ?', 'allow_private = ?');
            params.push(validateWebhookUrl(patch.url), patch.allowPrivate ? 1 : 0);
        }
        if (patch.events !== undefined) { sets.push('events_json = ?'); params.push(JSON.stringify(patch.events.length ? patch.events : ['*'])); }
        if (patch.accountIds !== undefined) { sets.push('account_ids_json = ?'); params.push(patch.accountIds && patch.accountIds.length ? JSON.stringify(patch.accountIds) : null); }
        if (patch.active !== undefined) {
            sets.push('active = ?'); params.push(patch.active ? 1 : 0);
            if (patch.active) { sets.push('consecutive_failures = 0', 'disabled_reason = NULL'); }
        }
        if (sets.length) {
            sets.push('updated_at = ?'); params.push(Date.now());
            apiDb().run(`UPDATE webhook_subscriptions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
            this.hub.invalidateConsumers();
            if (patch.active) this.schedulePump();
        }
        return this.get(id);
    }

    remove(id: string, keyId?: string | null): void {
        this.get(id, keyId);
        const db = apiDb();
        db.transaction(() => {
            db.run('DELETE FROM webhook_deliveries WHERE subscription_id = ?', [id]);
            db.run('DELETE FROM webhook_subscriptions WHERE id = ?', [id]);
        });
        this.hub.invalidateConsumers();
    }

    /** Xoá mọi webhook của một chủ (key bị xoá hẳn, plugin bị gỡ). */
    removeByOwner(keyId: string): number {
        if (!apiTablesExist()) return 0;
        const ids = apiDb().query<{ id: string }>('SELECT id FROM webhook_subscriptions WHERE key_id = ?', [keyId]).map(r => r.id);
        for (const id of ids) this.remove(id);
        return ids.length;
    }

    deliveries(subscriptionId: string, opts: { status?: string; limit?: number } = {}): any[] {
        const lim = Math.min(Math.max(1, opts.limit || 100), 500);
        const rows = opts.status
            ? apiDb().query<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE subscription_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?', [subscriptionId, opts.status, lim])
            : apiDb().query<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE subscription_id = ? ORDER BY created_at DESC LIMIT ?', [subscriptionId, lim]);
        return rows.map(r => ({
            id: r.id, event_seq: r.event_seq, event_type: r.event_type, attempt: r.attempt, status: r.status,
            response_status: r.response_status, response_body: r.response_body, error: r.error,
            next_retry_at: r.next_retry_at, created_at: r.created_at, delivered_at: r.delivered_at,
        }));
    }

    retry(deliveryId: string, keyId?: string | null): void {
        const row = apiDb().queryOne<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId]);
        if (!row) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy lần gửi');
        this.get(row.subscription_id, keyId);
        apiDb().run(`UPDATE webhook_deliveries SET status = 'pending', next_retry_at = ? WHERE id = ?`, [Date.now(), deliveryId]);
        this.schedulePump();
    }

    /** Gửi thử ngay một sự kiện "ping" (không lưu), trả kết quả HTTP. */
    async test(id: string, keyId?: string | null): Promise<PostResult & { took_ms: number }> {
        this.get(id, keyId);
        const row = apiDb().queryOne<SubRow>('SELECT * FROM webhook_subscriptions WHERE id = ?', [id])!;
        const event = { id: `evt_ping_${Date.now()}`, seq: 0, type: 'ping', ts: Date.now(), account_id: '', channel: '', data: { message: 'Deplao webhook test' } };
        const started = Date.now();
        const r = await this.post(row.url, decryptSecret(row.secret), `dlv_test_${Date.now()}`, 'ping', JSON.stringify(event), this.allowPrivate(row.allow_private));
        return { ...r, took_ms: Date.now() - started };
    }

    // ─── Hàng đợi ────────────────────────────────────────────────────────

    private allowPrivate(flag: number): boolean {
        return !!flag || getApiSettingBool('api_allow_private_urls');
    }

    private activeSubs(): SubRow[] {
        if (!apiTablesExist()) return [];
        return apiDb().query<SubRow>('SELECT * FROM webhook_subscriptions WHERE active = 1');
    }

    /** Ghi lần gửi cho các subscription khớp. Trả số lần gửi tạo ra. */
    enqueue(event: ApiEvent): number {
        if (!event.seq) return 0;
        let count = 0;
        try {
            const subs = this.activeSubs();
            if (subs.length === 0) return 0;
            const db = apiDb();
            const now = Date.now();
            const payload = JSON.stringify(event);
            for (const row of subs) {
                const sub = toSub(row);
                let principal: Principal | null = null;
                if (sub.key_id) {
                    principal = this.deps.principalForKey(sub.key_id);
                    if (!principal) continue; // key bị thu hồi/hết hạn → không gửi
                }
                if (!canReceive({ principal, types: sub.events, accountIds: sub.account_ids }, event)) continue;
                db.run(
                    `INSERT INTO webhook_deliveries (id, subscription_id, event_seq, event_type, payload_json, attempt, status, next_retry_at, created_at)
                     VALUES (?,?,?,?,?,0,'pending',?,?)`,
                    [`dlv_${randomUUID().replace(/-/g, '').slice(0, 24)}`, sub.id, event.seq, event.type, payload, now, now],
                );
                count++;
            }
        } catch (err: any) {
            this.deps.logError?.(`[Webhook] enqueue: ${err?.message || err}`);
        }
        if (count > 0) this.schedulePump();
        return count;
    }

    /** Chạy hàng đợi tới khi hết việc đến hạn; trả số lần gửi thành công trong lượt (test/thủ công). */
    tick(): Promise<number> {
        const before = this.deliveredCount;
        return new Promise(resolve => {
            this.idleWaiters.push(() => resolve(this.deliveredCount - before));
            this.pump();
        });
    }

    private schedulePump(): void {
        if (this.pumpScheduled) return;
        this.pumpScheduled = true;
        setImmediate(() => {
            this.pumpScheduled = false;
            this.pump();
        });
    }

    private notifyIdle(): void {
        if (this.active > 0) return;
        const waiters = this.idleWaiters.splice(0);
        for (const w of waiters) w();
    }

    private canRun(): boolean {
        try {
            return apiTablesExist() && getApiSettingBool('api_enabled');
        } catch {
            return false;
        }
    }

    /** Lần gửi đến hạn cũ nhất — của một URL cho trước, hoặc của URL chưa bận. */
    private nextDue(now: number, url?: string): DueRow | null {
        const params: any[] = [now];
        let extra = '';
        if (url !== undefined) {
            extra = 'AND s.url = ?';
            params.push(url);
        } else {
            const busy = new Set(this.inflightUrls);
            for (const [u, until] of this.cooldown) {
                if (until > now) busy.add(u);
                else this.cooldown.delete(u);
            }
            if (busy.size) {
                extra = `AND s.url NOT IN (${Array.from(busy).map(() => '?').join(',')})`;
                params.push(...busy);
            }
        }
        return apiDb().queryOne<DueRow>(
            `SELECT d.*, s.url AS url, s.secret AS secret, s.allow_private AS allow_private
               FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
              WHERE d.status = 'pending' AND s.active = 1 AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?) ${extra}
              ORDER BY d.created_at ASC LIMIT 1`,
            params,
        ) || null;
    }

    private pump(): void {
        if (!this.canRun()) {
            this.notifyIdle();
            return;
        }
        const now = Date.now();
        if (now - this.lastPrune > 3_600_000) {
            this.lastPrune = now;
            this.prune(now);
        }
        try {
            while (this.active < CONCURRENCY) {
                const row = this.nextDue(Date.now());
                if (!row) break;
                const url = row.url;
                this.active++;
                this.inflightUrls.add(url);
                this.drainUrl(url, row)
                    .catch(err => this.deps.logError?.(`[Webhook] drain: ${err?.message || err}`))
                    .finally(() => {
                        this.inflightUrls.delete(url);
                        this.active--;
                        this.pump();
                    });
            }
        } catch (err: any) {
            this.deps.logError?.(`[Webhook] pump: ${err?.message || err}`);
        }
        this.notifyIdle();
    }

    /** Gửi tuần tự các lần gửi đến hạn của một URL (tối đa PER_URL_BURST rồi nhường lượt). */
    private async drainUrl(url: string, first: DueRow): Promise<void> {
        let row: DueRow | null = first;
        for (let i = 0; row && i < PER_URL_BURST; i++) {
            let disabled = false;
            try {
                disabled = await this.deliver(row);
            } catch (err: any) {
                // Lỗi bất ngờ (DB...) → hoãn lần gửi này để không lặp nóng.
                this.deps.logError?.(`[Webhook] deliver ${row.id}: ${err?.message || err}`);
                this.cooldown.set(url, Date.now() + 60_000);
                try { apiDb().run('UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?', [Date.now() + 60_000, row.id]); } catch { /* ignore */ }
                return;
            }
            if (disabled || !this.canRun()) return;
            row = this.nextDue(Date.now(), url);
        }
    }

    private async post(url: string, secret: string, deliveryId: string, eventType: string, body: string, allowPrivate: boolean): Promise<PostResult> {
        if (!secret) {
            return { ok: false, status: null, body: '', error: 'Không giải mã được secret trên máy này — xoá và tạo lại webhook' };
        }
        const ts = Math.floor(Date.now() / 1000);
        const request = this.deps.requestImpl || guardedRequest;
        try {
            const res = await request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Deplao-Webhook/1',
                    'X-Deplao-Event': eventType,
                    'X-Deplao-Delivery': deliveryId,
                    'X-Deplao-Timestamp': String(ts),
                    'X-Deplao-Signature': signPayload(secret, ts, body),
                },
                body,
                timeoutMs: TIMEOUT_MS,
                allowPrivate,
                maxRedirects: 0,
                maxBytes: RESPONSE_BODY_MAX,
            });
            const ok = res.status >= 200 && res.status < 300;
            const redirect = res.status >= 300 && res.status < 400;
            return {
                ok,
                status: res.status,
                body: res.body.toString('utf8'),
                error: ok ? null : redirect ? `HTTP ${res.status} — webhook không đi theo redirect, hãy dùng URL cuối cùng` : `HTTP ${res.status}`,
            };
        } catch (err: any) {
            return { ok: false, status: null, body: '', error: describeError(err) };
        }
    }

    /** Gửi một lần; trả true nếu subscription vừa bị tự tắt. */
    private async deliver(d: DueRow): Promise<boolean> {
        const r = await this.post(d.url, decryptSecret(d.secret), d.id, d.event_type, d.payload_json, this.allowPrivate(d.allow_private));
        const db = apiDb();
        const attempt = Number(d.attempt) + 1;
        const now = Date.now();
        if (r.ok) {
            db.run(`UPDATE webhook_deliveries SET status='delivered', attempt=?, response_status=?, response_body=?, error=NULL, delivered_at=?, next_retry_at=NULL WHERE id=?`,
                [attempt, r.status, r.body, now, d.id]);
            db.run('UPDATE webhook_subscriptions SET consecutive_failures = 0, last_delivery_at = ? WHERE id = ?', [now, d.subscription_id]);
            this.deliveredCount++;
            return false;
        }
        const failed = attempt >= MAX_ATTEMPTS;
        db.run(`UPDATE webhook_deliveries SET status=?, attempt=?, response_status=?, response_body=?, error=?, next_retry_at=? WHERE id=?`,
            [failed ? 'failed' : 'pending', attempt, r.status, r.body, r.error || `HTTP ${r.status}`, failed ? null : now + RETRY_SCHEDULE_MS[attempt - 1], d.id]);
        db.run('UPDATE webhook_subscriptions SET consecutive_failures = consecutive_failures + 1 WHERE id = ?', [d.subscription_id]);
        const sub = db.queryOne<{ consecutive_failures: number; active: number }>('SELECT consecutive_failures, active FROM webhook_subscriptions WHERE id = ?', [d.subscription_id]);
        if (sub && sub.active && Number(sub.consecutive_failures) >= DISABLE_AFTER_FAILURES) {
            db.run(`UPDATE webhook_subscriptions SET active = 0, disabled_reason = ? WHERE id = ?`,
                [`Tự tắt sau ${DISABLE_AFTER_FAILURES} lần gửi lỗi liên tiếp`, d.subscription_id]);
            this.hub.invalidateConsumers();
            this.deps.logError?.(`[Webhook] subscription ${d.subscription_id} auto-disabled`);
            return true;
        }
        return false;
    }

    /** Dọn lần gửi cũ: delivered 7 ngày, failed 30 ngày, pending của webhook đã tắt quá 7 ngày. */
    prune(now = Date.now()): void {
        if (!apiTablesExist()) return;
        try {
            const db = apiDb();
            db.run(`DELETE FROM webhook_deliveries WHERE status='delivered' AND created_at < ?`, [now - 7 * 86_400_000]);
            db.run(`DELETE FROM webhook_deliveries WHERE status='failed' AND created_at < ?`, [now - 30 * 86_400_000]);
            db.run(`DELETE FROM webhook_deliveries WHERE status='pending' AND created_at < ?
                      AND subscription_id IN (SELECT id FROM webhook_subscriptions WHERE active = 0)`, [now - 7 * 86_400_000]);
        } catch { /* ignore */ }
    }
}
