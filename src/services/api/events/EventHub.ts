/**
 * EventHub — nguồn sự kiện công khai DUY NHẤT cho Socket.IO, SSE, polling, webhook và plugin.
 *
 *  - Hook EventBroadcaster.onBeforeSend (cùng cơ chế workflow/relay dùng). Callback chỉ làm
 *    `setImmediate` khi đang "capture" → không kéo dài đường xử lý tin nhắn.
 *  - Chỉ capture khi API bật VÀ có người dùng event (key có events/webhooks, subscription,
 *    socket/SSE/plugin đang nghe). Người không dùng API: không ghi gì.
 *  - Lưu api_events để catch-up/polling (có trần số dòng + số ngày), trừ sự kiện ephemeral.
 */
import { randomUUID } from 'crypto';
import { apiDb, apiTablesExist } from '../dbSchema';
import { getApiSettingBool, getApiSettingNumber } from '../settings';
import { accountAllowed } from '../auth/ApiAuth';
import type { Principal } from '../types';
import { eventInfo, typeMatches } from './catalog';
import { NormalizeHelpers, normalizeEvent, PartialEvent, SOURCE_CHANNELS } from './normalize';

export interface ApiEvent {
    id: string;
    seq: number;
    type: string;
    ts: number;
    account_id: string;
    channel: string;
    data: any;
}

export interface EventListener {
    /** Người nhận — dùng để lọc theo tài khoản được phép. null = nội bộ (thấy tất cả). */
    principal: Principal | null;
    types?: string[] | null;
    accountIds?: string[] | null;
    handler: (event: ApiEvent) => void;
}

export interface EventHubDeps {
    helpers: NormalizeHelpers;
    onBeforeSend: (channel: string, cb: (data: any) => void) => () => void;
    logError?: (msg: string) => void;
}

const MAX_EVENT_BYTES = 256 * 1024;
const PRUNE_EVERY_MS = 3600_000;
const CONSUMER_CHECK_MS = 30_000;

export function canReceive(listener: Pick<EventListener, 'principal' | 'types' | 'accountIds'>, event: ApiEvent): boolean {
    if (!typeMatches(listener.types || null, event.type)) return false;
    const p = listener.principal;
    if (event.account_id) {
        if (p && !accountAllowed(p, event.account_id)) return false;
        if (listener.accountIds && listener.accountIds.length && !listener.accountIds.includes(event.account_id)) return false;
    } else if (p && p.accountIds !== null) {
        // Sự kiện toàn hệ thống (thanh toán, plugin...) chỉ cho key không giới hạn tài khoản.
        return false;
    }
    return true;
}

function truncate(data: any): { data: any; truncated: boolean } {
    try {
        const json = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        if (json.length <= MAX_EVENT_BYTES) return { data: JSON.parse(json), truncated: false };
        return { data: { truncated: true, size: json.length }, truncated: true };
    } catch {
        return { data: null, truncated: true };
    }
}

export class EventHub {
    private listeners = new Set<EventListener>();
    private unsubscribers: Array<() => void> = [];
    private bound = new Map<string, (data: any) => void>();
    private lastPrune = 0;
    private consumerCache: { at: number; value: boolean } | null = null;
    private memorySeq = 0;

    constructor(private readonly deps: EventHubDeps) {}

    /** Đăng ký (lại) hook. Gọi khi khởi động và sau khi đổi workspace (clearBeforeSendHooks). */
    hook(): void {
        for (const u of this.unsubscribers) { try { u(); } catch { /* ignore */ } }
        this.unsubscribers = [];
        for (const channel of SOURCE_CHANNELS) {
            let cb = this.bound.get(channel);
            if (!cb) {
                cb = (data: any) => this.ingest(channel, data);
                this.bound.set(channel, cb);
            }
            this.unsubscribers.push(this.deps.onBeforeSend(channel, cb));
        }
    }

    unhook(): void {
        for (const u of this.unsubscribers) { try { u(); } catch { /* ignore */ } }
        this.unsubscribers = [];
    }

    subscribe(listener: EventListener): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    listenerCount(): number {
        return this.listeners.size;
    }

    invalidateConsumers(): void {
        this.consumerCache = null;
    }

    /** Có ai dùng event không (rẻ, cache 30 giây, không tạo bảng). */
    isCapturing(): boolean {
        if (!getApiSettingBool('api_enabled')) return false;
        if (this.listeners.size > 0) return true;
        const now = Date.now();
        if (this.consumerCache && now - this.consumerCache.at < CONSUMER_CHECK_MS) return this.consumerCache.value;
        let value = false;
        try {
            if (apiTablesExist()) {
                const db = apiDb();
                const keys = db.queryOne<{ n: number }>(
                    `SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL
                       AND (scopes_json LIKE '%events:subscribe%' OR scopes_json LIKE '%"admin"%' OR scopes_json LIKE '%webhooks:manage%')`,
                );
                const subs = db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE active = 1');
                value = Number(keys?.n) > 0 || Number(subs?.n) > 0;
            }
        } catch {
            value = false;
        }
        this.consumerCache = { at: now, value };
        return value;
    }

    /** Callback của hook: tuyệt đối không ném lỗi, không làm việc nặng đồng bộ. */
    ingest(source: string, data: any): void {
        try {
            if (!this.isCapturing()) return;
            setImmediate(() => {
                this.process(source, data).catch(err => this.deps.logError?.(`[EventHub] ${source}: ${err?.message || err}`));
            });
        } catch (err: any) {
            this.deps.logError?.(`[EventHub] ingest ${source}: ${err?.message || err}`);
        }
    }

    async process(source: string, data: any): Promise<ApiEvent[]> {
        const partials = await normalizeEvent(source, data, this.deps.helpers);
        return partials.map(p => this.publish(p));
    }

    /** Phát một sự kiện đã chuẩn hoá (dùng cho plugin, webhook ping, test). */
    publish(partial: PartialEvent): ApiEvent {
        const info = eventInfo(partial.type);
        const { data, truncated } = truncate(partial.data);
        const event: ApiEvent = {
            id: `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            seq: 0,
            type: partial.type,
            ts: Date.now(),
            account_id: partial.account_id || '',
            channel: partial.channel || '',
            data: truncated ? { ...data, truncated: true } : data,
        };
        if (!info?.ephemeral) {
            event.seq = this.persist(event);
        } else {
            event.seq = 0;
        }
        for (const l of Array.from(this.listeners)) {
            try {
                if (canReceive(l, event)) l.handler(event);
            } catch (err: any) {
                this.deps.logError?.(`[EventHub] listener error: ${err?.message || err}`);
            }
        }
        this.maybePrune();
        return event;
    }

    private persist(event: ApiEvent): number {
        try {
            const { seq, ...rest } = event;
            return apiDb().runInsert(
                'INSERT INTO api_events (event_id, type, account_id, channel, payload_json, created_at) VALUES (?,?,?,?,?,?)',
                [event.id, event.type, event.account_id, event.channel, JSON.stringify(rest), event.ts],
            );
        } catch (err: any) {
            this.deps.logError?.(`[EventHub] persist: ${err?.message || err}`);
            return ++this.memorySeq;
        }
    }

    /** Event sau `since` (seq) mà listener được phép nhận. */
    replay(since: number, filter: Pick<EventListener, 'principal' | 'types' | 'accountIds'>, limit = 500): ApiEvent[] {
        if (!apiTablesExist()) return [];
        const lim = Math.min(Math.max(1, limit), 5000);
        const out: ApiEvent[] = [];
        let cursor = Math.max(0, Number(since) || 0);
        // Đọc theo lô để lọc quyền mà vẫn trả đủ `limit` (giới hạn 20 lô / lần gọi).
        for (let round = 0; round < 20 && out.length < lim; round++) {
            const rows = apiDb().query<{ seq: number; payload_json: string }>(
                'SELECT seq, payload_json FROM api_events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
                [cursor, 500],
            );
            if (rows.length === 0) break;
            for (const r of rows) {
                cursor = Number(r.seq);
                let ev: ApiEvent;
                try { ev = { ...JSON.parse(r.payload_json), seq: Number(r.seq) }; } catch { continue; }
                if (canReceive(filter, ev)) out.push(ev);
                if (out.length >= lim) break;
            }
        }
        return out;
    }

    latestSeq(): number {
        if (!apiTablesExist()) return 0;
        try {
            return Number(apiDb().queryOne<{ s: number }>('SELECT MAX(seq) AS s FROM api_events')?.s) || 0;
        } catch {
            return 0;
        }
    }

    private maybePrune(now = Date.now()): void {
        if (now - this.lastPrune < PRUNE_EVERY_MS) return;
        this.lastPrune = now;
        try {
            const db = apiDb();
            const days = Math.max(1, getApiSettingNumber('api_events_days') || 7);
            const max = Math.max(1000, getApiSettingNumber('api_events_max') || 50_000);
            db.run('DELETE FROM api_events WHERE created_at < ?', [now - days * 86_400_000]);
            const latest = this.latestSeq();
            if (latest > max) db.run('DELETE FROM api_events WHERE seq <= ?', [latest - max]);
        } catch { /* ignore */ }
    }
}
