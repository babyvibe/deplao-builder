/**
 * RemotePluginClient — runtime "remote": logic plugin chạy trên server của bên thứ ba.
 *
 * Deplao → plugin: POST {remote.baseUrl}/rpc   body { id, method, params }
 *   X-Deplao-Plugin: <id>   X-Deplao-Timestamp: <giây>   X-Deplao-Signature: v1=<HMAC-SHA256(secret, ts + "." + body)>
 *   Trả về HTTP 200 { result } hoặc { error: { code, message } }.
 * Plugin → Deplao: gọi API v1 bằng API key tạo tự động lúc cài (gắn plugin_id, thu hồi khi gỡ).
 *
 * Server remote tạm không chạy khi bật app → chỉ ghi cảnh báo, không tắt plugin.
 */
import { randomUUID } from 'crypto';
import { guardedRequest } from '../api/http/netGuard';
import { getApiSettingBool } from '../api/settings';
import { signPayload } from '../api/events/WebhookOutboundService';
import type { PluginRuntimeHandle, RuntimeContext, RuntimeStats } from './PluginManager';
import { TIMEOUTS } from './PluginSandbox';

function isLoopbackUrl(url: string): boolean {
    try {
        const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
        return h === '127.0.0.1' || h === 'localhost' || h === '::1';
    } catch {
        return false;
    }
}

export class RemotePluginClient implements PluginRuntimeHandle {
    private startedAt = 0;
    private lastError: string | undefined;
    private lastOkAt = 0;
    private calls = 0;

    constructor(
        private readonly ctx: RuntimeContext,
        private readonly requestImpl: typeof guardedRequest = guardedRequest,
    ) {}

    private endpoint(): string {
        const base = String(this.ctx.record.manifest.remote?.baseUrl || '').replace(/\/+$/, '');
        return `${base}/rpc`;
    }

    async call(method: string, params: any, timeoutMs = TIMEOUTS.default): Promise<any> {
        const secret = this.ctx.remoteSecret();
        if (!secret) throw new Error('Thiếu secret của ứng dụng (server ngoài) — cài lại ứng dụng');
        const body = JSON.stringify({ id: randomUUID(), method, params: params ?? {} });
        const ts = Math.floor(Date.now() / 1000);
        const url = this.endpoint();
        this.calls++;
        const res = await this.requestImpl(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Deplao-Plugin/1',
                'X-Deplao-Plugin': this.ctx.record.id,
                'X-Deplao-Timestamp': String(ts),
                'X-Deplao-Signature': signPayload(secret, ts, body),
            },
            body,
            timeoutMs,
            allowPrivate: isLoopbackUrl(url) || getApiSettingBool('api_allow_private_urls'),
            maxRedirects: 0,
            maxBytes: 5 * 1024 * 1024,
        }).catch((err: any) => {
            this.lastError = err?.message || String(err);
            throw Object.assign(new Error(`Không gọi được server của ứng dụng: ${this.lastError}`), { code: err?.code === 'TIMEOUT' ? 'TIMEOUT' : 'UPSTREAM_ERROR' });
        });
        let json: any = null;
        try { json = JSON.parse(res.body.toString('utf8') || 'null'); } catch { /* xử lý dưới */ }
        if (res.status < 200 || res.status >= 300 || !json || typeof json !== 'object') {
            this.lastError = `HTTP ${res.status}`;
            throw Object.assign(new Error(`Server của ứng dụng trả HTTP ${res.status}`), { code: 'UPSTREAM_ERROR', status: 502 });
        }
        // Server trả lời đúng giao thức → kết nối tốt (lỗi nghiệp vụ của plugin không tính là mất kết nối).
        this.lastError = undefined;
        this.lastOkAt = Date.now();
        if (json.error) {
            throw Object.assign(new Error(String(json.error.message || 'Server của ứng dụng báo lỗi')), { code: json.error.code || 'PLUGIN_ERROR' });
        }
        return json.result;
    }

    async start(init: { settings: Record<string, any>; prevVersion?: string }): Promise<void> {
        this.startedAt = Date.now();
        try {
            await this.call('activate', init, TIMEOUTS.activate);
        } catch (err: any) {
            this.ctx.onLog('warn', `Chưa kết nối được server của ứng dụng (${this.endpoint()}): ${err?.message || err}. Ứng dụng vẫn bật, sẽ thử ở lần gọi sau.`);
        }
    }

    async stop(): Promise<void> {
        try { await this.call('deactivate', {}, TIMEOUTS.deactivate); } catch { /* server không chạy */ }
    }

    notify(method: string, params: any): void {
        this.call(method, params, 10_000).catch(err => this.ctx.onLog('warn', `Gửi ${method} tới server của ứng dụng lỗi: ${err?.message || err}`));
    }

    stats(): RuntimeStats {
        return {
            running: true,
            restarts: 0,
            startedAt: this.startedAt || undefined,
            lastError: this.lastError,
            remote: {
                baseUrl: String(this.ctx.record.manifest.remote?.baseUrl || ''),
                connected: this.lastError ? false : this.lastOkAt ? true : null,
                lastOkAt: this.lastOkAt || undefined,
                calls: this.calls,
            },
        };
    }
}
