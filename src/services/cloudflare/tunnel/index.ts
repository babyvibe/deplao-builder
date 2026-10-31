/**
 * Module tunnel của "Cloudflare tự động" — `cloudTunnel: CloudTunnelModule` (hợp đồng ở ../contracts.ts).
 * Logic: CloudflareTunnelManager.ts (cấp phát / ingress / DNS / sức khoẻ), ingress.ts, dns.ts.
 *
 * Tiến trình: MỘT cloudflared cho cả ba dịch vụ, chạy qua TunnelService (tự chạy lại theo backoff, make-before-break khi
 * đổi tunnel) với khoá phiên giả CLOUD_TUNNEL_SESSION_PORT (không phải cổng thật). Token đi qua biến môi trường
 * TUNNEL_TOKEN (không lộ trong danh sách tiến trình), metrics 127.0.0.1:<cổng ngẫu nhiên> để đọc /ready.
 *
 * Nơi dùng địa chỉ (chỉ khi chế độ 'cloudflare_auto'; chế độ khác chạy y như cũ):
 *   - integrations/PaymentsTunnel.ts     (tunnel:start/stop/status)   → dịch vụ 'payments'
 *   - WebhookGatewayService              startTunnel/stopTunnel/status → dịch vụ 'workflow'
 *   - HttpRelayService                   startTunnel/stopTunnel/status → dịch vụ 'relay'
 * Các nơi đó nạp module này LƯỜI (require trong hàm, lỗi → null) và gọi isCloudTunnelAuto() trước.
 *
 * Chế độ khác (Địa chỉ tạm / ngrok / Cloudflare thủ công): Cài đặt → Internet & Đám mây → Địa chỉ Internet là nơi DUY
 * NHẤT bật / tắt địa chỉ. setServiceEnabled đi qua cầu legacyBridge bên dưới vào đúng các hàm cũ ở trên (nạp lười), nên
 * hành vi từng cổng giữ nguyên: relay dùng nhà cung cấp đã chọn, thanh toán / workflow dùng Quick Tunnel riêng.
 */
import * as http from 'http';
import Logger from '../../../utils/Logger';
import TunnelService, { type TunnelOptions } from '../../tunnel/TunnelService';
import { cloudflare } from '../CloudflareService';
import { CloudError, type CloudTunnelModule } from '../contracts';
import type { TunnelMode, TunnelServiceId } from '../../../shared/cloud/cloudContracts';
import {
    CloudflareTunnelManager,
    type CloudTunnelRunner,
    type LegacyTunnelBridge,
    type ReadyInfo,
    type RunnerSnapshot,
    type RunnerStartInput,
} from './CloudflareTunnelManager';
import { defaultServicePort, type ServicePorts } from './ingress';

/** Khoá phiên TunnelService của tiến trình cloudflared dùng chung (một tiến trình phục vụ cả 3 cổng). */
export const CLOUD_TUNNEL_SESSION_PORT = 0;
const SESSION_LABEL = 'Cloudflare tự động';
/** Đọc /ready nền khi cloudflared chạy. */
const READY_POLL_MS = 15_000;
const READY_TIMEOUT_MS = 2_500;

// ─── Tiến trình cloudflared (TunnelService) ──────────────────────────────────

/** GET http://127.0.0.1:<port>/ready — 200 = có kết nối, 503 = chưa / mất kết nối; lỗi mạng → null. */
function fetchReady(port: number): Promise<ReadyInfo | null> {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/ready', timeout: READY_TIMEOUT_MS }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => { if (body.length < 8192) body += chunk; });
            res.on('end', () => {
                let data: any = null;
                try { data = JSON.parse(body); } catch { data = null; }
                resolve({
                    ready: res.statusCode === 200,
                    readyConnections: Number(data?.readyConnections) || 0,
                    connectorId: typeof data?.connectorId === 'string' && data.connectorId ? data.connectorId : null,
                });
            });
            res.on('error', () => resolve(null));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve(null));
    });
}

function createTunnelServiceRunner(): CloudTunnelRunner {
    let tunnelId: string | null = null;
    const options = (input: RunnerStartInput): TunnelOptions => ({
        provider: 'cloudflare_named',
        token: input.token,
        publicUrl: input.publicUrl,
        // Địa chỉ cố định: lần bật đầu lỗi (chưa có mạng…) vẫn tự thử lại
        keepAlive: true,
        // Ingress do Deplao quản lý qua API (nhiều tên / đường dẫn) — không đối chiếu kiểu một Public Hostname
        managedIngress: true,
    });
    return {
        async start(input) {
            tunnelId = input.tunnelId;
            await TunnelService.start(CLOUD_TUNNEL_SESSION_PORT, SESSION_LABEL, options(input));
        },
        async replace(input) {
            const previous = tunnelId;
            const hadActive = TunnelService.getState(CLOUD_TUNNEL_SESSION_PORT)?.state === 'active';
            tunnelId = input.tunnelId;
            try {
                await TunnelService.replace(CLOUD_TUNNEL_SESSION_PORT, SESSION_LABEL, options(input));
            } catch (err) {
                // replace() lỗi khi đang có tunnel chạy → tunnel cũ giữ nguyên; không có thì phiên mới vẫn tự thử lại
                if (hadActive) tunnelId = previous;
                throw err;
            }
        },
        async stop() {
            await TunnelService.stop(CLOUD_TUNNEL_SESSION_PORT);
        },
        snapshot(): RunnerSnapshot | null {
            const state = TunnelService.getState(CLOUD_TUNNEL_SESSION_PORT);
            if (!state) return null;
            return {
                tunnelId,
                state: state.state,
                lastError: state.lastError,
                restarts: state.restarts,
                attempt: state.attempt,
                nextRetryAt: state.nextRetryAt,
                metricsPort: state.metricsPort ?? null,
                connectorId: state.connectorId ?? null,
                version: state.cloudflaredVersion ?? null,
            };
        },
        async readiness() {
            const port = TunnelService.getState(CLOUD_TUNNEL_SESSION_PORT)?.metricsPort;
            return port ? fetchReady(port) : null;
        },
        onChange(cb) {
            return TunnelService.watch(CLOUD_TUNNEL_SESSION_PORT, () => cb());
        },
    };
}

// ─── Cổng dịch vụ + tunnel kiểu cũ ───────────────────────────────────────────

/** Cổng thật của dịch vụ (thanh toán tự lùi sang cổng kế khi 9888 bận; relay có thể đổi cổng). */
function servicePort(service: TunnelServiceId): number {
    try {
        if (service === 'payments') return Number(require('../../integrations/IntegrationRegistry').default.getWebhookPort()) || defaultServicePort(service);
        if (service === 'workflow') return Number(require('../../workflow/WebhookGatewayService').default.getInstance().getStatus().port) || defaultServicePort(service);
        return Number(require('../../http/HttpRelayService').default.getInstance().getStatus().port) || defaultServicePort(service);
    } catch {
        return defaultServicePort(service);
    }
}

function currentPorts(): ServicePorts {
    return { relay: servicePort('relay'), payments: servicePort('payments'), workflow: servicePort('workflow') };
}

/** relay_tunnel_provider (cấu hình relay cũ, trong DB workspace) ↔ TunnelMode. */
const PROVIDER_TO_MODE: Record<string, TunnelMode> = { cloudflare: 'quick', ngrok: 'ngrok', cloudflare_named: 'cloudflare_manual' };
const MODE_TO_PROVIDER: Partial<Record<TunnelMode, string>> = { quick: 'cloudflare', ngrok: 'ngrok', cloudflare_manual: 'cloudflare_named' };

function settingsDb(): any | null {
    try { return require('../../database/DatabaseService').default.getInstance(); } catch { return null; }
}

/** "Tự bật tunnel khi mở app" của relay (relay:setTunnelConfig { autoStart } ghi cùng khoá; relay đọc khi server chạy). */
const RELAY_TUNNEL_AUTOSTART_KEY = 'relay_tunnel_autostart';

const SERVICE_LABEL: Record<TunnelServiceId, string> = {
    relay: 'Nhân viên và API',
    payments: 'Thanh toán, tích hợp',
    workflow: 'Webhook workflow',
};

function legacyFailure(service: TunnelServiceId, on: boolean, detail: unknown): CloudError {
    const text = String((detail as any)?.message ?? detail ?? '').trim();
    return new CloudError(
        on ? 'TUNNEL_START_FAILED' : 'TUNNEL_STOP_FAILED',
        `Không ${on ? 'bật' : 'tắt'} được địa chỉ ${SERVICE_LABEL[service]}${text ? `: ${text}` : ''}`,
    );
}

/** Cổng relay đã lưu của workspace đang mở (như lúc mở app tự bật relay); không đọc được → cổng relay đang nhớ. */
function workspaceRelayPort(): number | undefined {
    try {
        const ws = require('../../../utils/app/WorkspaceManager').default.getInstance().getActiveWorkspace();
        const port = Number(ws?.relayPort);
        if (ws?.type !== 'remote' && Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch { /* WorkspaceManager chưa sẵn sàng */ }
    return undefined;
}

/**
 * Bật tunnel kiểu cũ của một dịch vụ — đúng các hàm mà relay:startTunnel / tunnel:start / workflow:startTunnel gọi.
 * Chỉ chạy khi KHÔNG ở 'cloudflare_auto' (manager kiểm trong hàng đợi) nên các hàm đó không gọi ngược setServiceEnabled.
 */
async function startLegacyTunnel(service: TunnelServiceId): Promise<void> {
    if (service === 'relay') {
        const relay = require('../../http/HttpRelayService').default.getInstance();
        if (!relay.isRunning()) {
            // Như nút bật nhanh ở Cài đặt → Nhân viên: máy chủ nhân viên (LAN) chưa chạy → bật trước (relay:startServer)
            const port: number = workspaceRelayPort() ?? (Number(relay.getStatus().port) || defaultServicePort('relay'));
            const started = await relay.start(port);
            if (!started?.success) {
                throw new CloudError(
                    'RELAY_NOT_RUNNING',
                    `Bật máy chủ nhân viên (LAN) trước: chưa bật được trên cổng ${port}${started?.error ? ` (${started.error})` : ''}. Kiểm tra ở Cài đặt → Nhân viên → Kết nối rồi thử lại.`,
                );
            }
            Logger.log(`[CloudTunnel] Đã bật máy chủ nhân viên (LAN) trên cổng ${started.port ?? port} để bật địa chỉ Internet`);
        }
        const res = await relay.startTunnel();
        if (!res?.success) throw legacyFailure(service, true, res?.error);
        return;
    }
    if (service === 'payments') {
        const { startPaymentsTunnel } = require('../../integrations/PaymentsTunnel') as typeof import('../../integrations/PaymentsTunnel');
        const res = await startPaymentsTunnel();
        if (!res?.success) throw legacyFailure(service, true, res?.error);
        return;
    }
    const gateway = require('../../workflow/WebhookGatewayService').default.getInstance();
    const status = gateway.getStatus();
    if (!status.running) {
        throw new CloudError('GATEWAY_NOT_RUNNING', `Máy chủ nhận webhook workflow (cổng ${status.port}) chưa chạy — khởi động lại Deplao rồi thử lại`);
    }
    const res = await gateway.startTunnel();
    if (!res?.success) throw legacyFailure(service, true, res?.error);
}

/** Tắt tunnel kiểu cũ của một dịch vụ (relay:stopTunnel / tunnel:stop / workflow:stopTunnel). */
async function stopLegacyTunnel(service: TunnelServiceId): Promise<void> {
    let res: { success: boolean; error?: string } | undefined;
    if (service === 'relay') {
        res = await require('../../http/HttpRelayService').default.getInstance().stopTunnel();
    } else if (service === 'payments') {
        const { stopPaymentsTunnel } = require('../../integrations/PaymentsTunnel') as typeof import('../../integrations/PaymentsTunnel');
        res = await stopPaymentsTunnel();
    } else {
        res = await require('../../workflow/WebhookGatewayService').default.getInstance().stopTunnel();
    }
    if (!res?.success) throw legacyFailure(service, false, res?.error);
}

const legacyBridge: LegacyTunnelBridge = {
    state(service) {
        const state = TunnelService.getState(servicePort(service));
        return state ? { url: state.url, state: state.state, kind: state.kind, lastError: state.lastError } : null;
    },
    mode() {
        const db = settingsDb();
        if (!db) return null;
        try { return PROVIDER_TO_MODE[String(db.getSetting('relay_tunnel_provider') || 'cloudflare')] ?? null; } catch { return null; }
    },
    setMode(mode) {
        const provider = MODE_TO_PROVIDER[mode];
        const db = settingsDb();
        if (provider && db) db.setSetting('relay_tunnel_provider', provider);
    },
    start: startLegacyTunnel,
    stop: stopLegacyTunnel,
    autoStart() {
        const db = settingsDb();
        if (!db) return null;
        try { return db.getSetting(RELAY_TUNNEL_AUTOSTART_KEY) === '1'; } catch { return null; }
    },
    setAutoStart(on) {
        const db = settingsDb();
        if (!db) throw new CloudError('DB_UNAVAILABLE', 'Chưa đọc được dữ liệu workspace — thử lại sau');
        db.setSetting(RELAY_TUNNEL_AUTOSTART_KEY, on ? '1' : '0');
    },
};

// ─── Module ──────────────────────────────────────────────────────────────────

const manager = new CloudflareTunnelManager({
    api: () => cloudflare.api(),
    settings: {
        get: () => cloudflare.settings.get(),
        update: (patch) => cloudflare.settings.update(patch),
    },
    runner: createTunnelServiceRunner(),
    notify: () => cloudflare.notifyChanged('tunnel'),
    ports: currentPorts,
    legacy: legacyBridge,
    log: { log: (message) => Logger.log(message), warn: (message) => Logger.warn(message) },
    readyPollMs: READY_POLL_MS,
});

export const cloudTunnel: CloudTunnelModule = manager;

/** Đang ở chế độ 'cloudflare_auto' (đọc cloud-settings; lỗi → false = chạy như cũ). */
export function isCloudTunnelAuto(): boolean {
    try {
        return cloudflare.settings.get()?.tunnel?.mode === 'cloudflare_auto';
    } catch {
        return false;
    }
}

/** Nghe thay đổi địa chỉ / tiến trình (relay, integrationIpc). Trả hàm huỷ. */
export function onCloudTunnelChange(cb: () => void): () => void {
    return manager.subscribe(cb);
}

/** Chi tiết tiến trình cloudflared dùng chung (restarts, attempt, nextRetryAt…) — null khi không chạy. */
export function cloudTunnelProcessInfo(): RunnerSnapshot | null {
    return manager.processInfo();
}

export default cloudTunnel;
