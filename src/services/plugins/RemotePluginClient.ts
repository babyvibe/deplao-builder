/**
 * RemotePluginClient: the "remote" runtime: plugin logic that runs on a third party's server.
 *
 * Deplao → plugin: POST {remote.baseUrl}/rpc   body { id, method, params }
 *   X-Deplao-Plugin: <id>   X-Deplao-Timestamp: <seconds>   X-Deplao-Signature: v1=<HMAC-SHA256(secret, ts + "." + body)>
 *   Returns HTTP 200 { result } or { error: { code, message } }.
 * Plugin → Deplao: calls API v1 with an API key created automatically at install (tied to plugin_id, revoked on uninstall).
 *
 * A remote server that is temporarily down when the app starts → only logs a warning, does not disable the plugin.
 */
import { randomUUID } from 'crypto';
import { guardedRequest } from '../api/http/netGuard';
import { getApiSettingBool } from '../api/settings';
import { signPayload } from '../api/events/WebhookOutboundService';
import type { PluginRuntimeHandle, RuntimeContext, RuntimeStats } from './PluginManager';
import { TIMEOUTS } from './PluginSandbox';
import { tr } from '../../shared/i18n';

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
        if (!secret) throw new Error(tr('Thiếu secret của ứng dụng (server ngoài) — cài lại ứng dụng'));
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
            throw Object.assign(new Error(tr('Không gọi được server của ứng dụng: {{lastError}}', { lastError: this.lastError })), { code: err?.code === 'TIMEOUT' ? 'TIMEOUT' : 'UPSTREAM_ERROR' });
        });
        let json: any = null;
        try { json = JSON.parse(res.body.toString('utf8') || 'null'); } catch { /* handled below */ }
        if (res.status < 200 || res.status >= 300 || !json || typeof json !== 'object') {
            this.lastError = `HTTP ${res.status}`;
            throw Object.assign(new Error(tr('Server của ứng dụng trả HTTP {{status}}', { status: res.status })), { code: 'UPSTREAM_ERROR', status: 502 });
        }
        // The server answered with the right protocol → the connection is good (a plugin business error does not count as a lost connection).
        this.lastError = undefined;
        this.lastOkAt = Date.now();
        if (json.error) {
            throw Object.assign(new Error(String(json.error.message || tr('Server của ứng dụng báo lỗi'))), { code: json.error.code || 'PLUGIN_ERROR' });
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
        try { await this.call('deactivate', {}, TIMEOUTS.deactivate); } catch { /* server not running */ }
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
