/**
 * SocketGateway — namespace Socket.IO `/v1` cho app ngoài & plugin (tách khỏi namespace gốc
 * của nhân viên, không đụng logic employee).
 *
 *   const s = io('http://127.0.0.1:9900/v1', { auth: { apiKey: 'dpk_...' } });
 *   s.on('hello', ({ seq_now }) => s.emit('subscribe', { types: ['message.*'], since: lastSeq ?? seq_now }));
 *   s.on('event', e => { lastSeq = e.seq || lastSeq; ... });
 */
import type { Principal } from '../types';
import { hasScope } from '../auth/ApiAuth';
import { ipAllowed, normalizeIp, isLoopback } from '../http/ip';
import { getApiSettingBool } from '../settings';
import { ApiEvent, EventHub } from './EventHub';

export interface SocketGatewayDeps {
    hub: EventHub;
    authenticate: (token: string, ip: string) => Principal | null;
    logError?: (msg: string) => void;
}

function socketIp(socket: any): string {
    const raw = normalizeIp(socket?.handshake?.address || '');
    if (getApiSettingBool('api_trust_proxy_headers') && isLoopback(raw)) {
        const h = socket?.handshake?.headers || {};
        const cf = h['cf-connecting-ip'];
        if (typeof cf === 'string' && cf) return normalizeIp(cf);
        const xff = String(h['x-forwarded-for'] || '').split(',')[0].trim();
        if (xff) return normalizeIp(xff);
    }
    return raw;
}

function tokenOf(socket: any): string {
    const auth = socket?.handshake?.auth || {};
    const direct = auth.apiKey || auth.token || auth.key;
    if (typeof direct === 'string' && direct) return direct.trim();
    const header = String(socket?.handshake?.headers?.authorization || '');
    if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
    const x = socket?.handshake?.headers?.['x-api-key'];
    return typeof x === 'string' ? x.trim() : '';
}

export class SocketGateway {
    private namespace: any = null;

    constructor(private readonly deps: SocketGatewayDeps) {}

    attach(io: any): void {
        if (!io || typeof io.of !== 'function') return;
        const ns = io.of('/v1');
        this.namespace = ns;
        ns.use((socket: any, next: (err?: Error) => void) => {
            try {
                if (!getApiSettingBool('api_enabled')) return next(new Error('API_DISABLED'));
                const ip = socketIp(socket);
                const principal = this.deps.authenticate(tokenOf(socket), ip);
                if (!principal) return next(new Error('UNAUTHORIZED'));
                if (!hasScope(principal, 'events:subscribe')) return next(new Error('FORBIDDEN_SCOPE'));
                if (!ipAllowed(ip, principal.allowedIps)) return next(new Error('FORBIDDEN_IP'));
                socket.data.principal = principal;
                next();
            } catch (err: any) {
                next(new Error('UNAUTHORIZED'));
            }
        });
        ns.on('connection', (socket: any) => this.onConnection(socket));
    }

    detach(): void {
        try { this.namespace?.disconnectSockets?.(true); } catch { /* ignore */ }
        this.namespace = null;
    }

    connectedCount(): number {
        try { return this.namespace?.sockets?.size || 0; } catch { return 0; }
    }

    private onConnection(socket: any): void {
        const principal: Principal = socket.data.principal;
        const hub = this.deps.hub;
        let unsubscribe: (() => void) | null = null;

        socket.emit('hello', {
            seq_now: hub.latestSeq(),
            server_time: Date.now(),
            principal: { kind: principal.kind, id: principal.id, name: principal.name },
        });

        socket.on('subscribe', (opts: any, ack?: (res: any) => void) => {
            try {
                unsubscribe?.();
                const types: string[] | null = Array.isArray(opts?.types) ? opts.types.map(String).slice(0, 50) : null;
                const accountIds: string[] | null = Array.isArray(opts?.account_ids) ? opts.account_ids.map(String).slice(0, 200) : null;
                const filter = { principal, types, accountIds };

                // Đăng ký trước, giữ event mới trong hàng chờ cho tới khi phát lại xong → không hụt.
                let replaying = true;
                const pending: ApiEvent[] = [];
                let lastReplayed = Number(opts?.since) || 0;
                unsubscribe = hub.subscribe({
                    ...filter,
                    handler: (ev) => {
                        if (replaying) pending.push(ev);
                        else socket.emit('event', ev);
                    },
                });
                if (opts?.since !== undefined && opts?.since !== null) {
                    for (const ev of hub.replay(Number(opts.since) || 0, filter, 5000)) {
                        socket.emit('event', ev);
                        lastReplayed = Math.max(lastReplayed, ev.seq);
                    }
                }
                replaying = false;
                for (const ev of pending) {
                    if (ev.seq && ev.seq <= lastReplayed) continue;
                    socket.emit('event', ev);
                }
                ack?.({ ok: true, seq_now: hub.latestSeq() });
            } catch (err: any) {
                this.deps.logError?.(`[SocketGateway] subscribe: ${err?.message || err}`);
                ack?.({ ok: false, error: 'SUBSCRIBE_FAILED' });
            }
        });

        socket.on('unsubscribe', (_: any, ack?: (res: any) => void) => {
            unsubscribe?.();
            unsubscribe = null;
            ack?.({ ok: true });
        });

        socket.on('disconnect', () => {
            unsubscribe?.();
            unsubscribe = null;
        });
    }
}
