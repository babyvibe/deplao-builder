/**
 * The module for "Cloudflare tự động" (automatic Cloudflare): `cloudTunnel: CloudTunnelModule` (contract in ../contracts.ts).
 * Logic: CloudflareTunnelManager.ts (provisioning / ingress / DNS / health), ingress.ts, dns.ts.
 *
 * Process: ONE cloudflared for all three services, run through TunnelService (restarts itself with backoff, make-before-break when
 * the tunnel changes) with the fake session key CLOUD_TUNNEL_SESSION_PORT (not a real port). The token is passed through the environment variable
 * TUNNEL_TOKEN (not visible in the process list), metrics on 127.0.0.1:<random port> to read /ready.
 *
 * Where the address is used (only when the mode is 'cloudflare_auto'; other modes run exactly as before):
 *   - integrations/PaymentsTunnel.ts     (tunnel:start/stop/status)   → service 'payments'
 *   - WebhookGatewayService              startTunnel/stopTunnel/status → service 'workflow'
 *   - HttpRelayService                   startTunnel/stopTunnel/status → service 'relay'
 * Those places load this module LAZILY (require inside the function, error → null) and call isCloudTunnelAuto() first.
 *
 * Other modes (temporary address / ngrok / manual Cloudflare): Settings → Internet & Cloud → Internet address is the ONLY place that turns the address on / off.
 * setServiceEnabled goes through the legacyBridge below into the same old functions above (lazy load), so the behavior of each port stays the same:
 * relay uses the chosen provider, payments / workflow use their own Quick Tunnel.
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
import { tr } from '../../../shared/i18n';

/** TunnelService session key of the shared cloudflared process (one process serves all 3 ports). */
export const CLOUD_TUNNEL_SESSION_PORT = 0;
const SESSION_LABEL = tr('Cloudflare tự động');
/** Background /ready read while cloudflared runs. */
const READY_POLL_MS = 15_000;
const READY_TIMEOUT_MS = 2_500;

// ─── cloudflared process (TunnelService) ──────────────────────────────────

/** GET http://127.0.0.1:<port>/ready: 200 = connected, 503 = not yet / connection lost; network error → null. */
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
        // Fixed address: if the first start fails (no network yet…), it still retries by itself
        keepAlive: true,
        // Ingress is managed by Deplao through the API (many names / paths): not matched like a single Public Hostname
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
                // replace() fails while a tunnel is running → the old tunnel stays; if none is running, the new session still retries by itself
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

// ─── Service ports + old-style tunnels ───────────────────────────────────────────

/** The real port of the service (payments step back to the next port when 9888 is busy; the relay may change its port). */
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

/** relay_tunnel_provider (old relay config, in the workspace DB) ↔ TunnelMode. */
const PROVIDER_TO_MODE: Record<string, TunnelMode> = { cloudflare: 'quick', ngrok: 'ngrok', cloudflare_named: 'cloudflare_manual' };
const MODE_TO_PROVIDER: Partial<Record<TunnelMode, string>> = { quick: 'cloudflare', ngrok: 'ngrok', cloudflare_manual: 'cloudflare_named' };

function settingsDb(): any | null {
    try { return require('../../database/DatabaseService').default.getInstance(); } catch { return null; }
}

/** The relay's "Tự bật tunnel khi mở app" (start tunnel on app launch) (relay:setTunnelConfig { autoStart } writes the same key; the relay reads it when its server runs). */
const RELAY_TUNNEL_AUTOSTART_KEY = 'relay_tunnel_autostart';

const SERVICE_LABEL: Record<TunnelServiceId, string> = {
    relay: tr('Nhân viên và API'),
    payments: tr('Thanh toán, tích hợp'),
    workflow: 'Webhook workflow',
};

function legacyFailure(service: TunnelServiceId, on: boolean, detail: unknown): CloudError {
    const text = String((detail as any)?.message ?? detail ?? '').trim();
    return new CloudError(
        on ? 'TUNNEL_START_FAILED' : 'TUNNEL_STOP_FAILED',
        tr('Không {{v1}} được địa chỉ {{v2}}{{v3}}', { v1: on ? tr('bật') : tr('tắt'), v2: SERVICE_LABEL[service], v3: text ? `: ${text}` : '' }),
    );
}

/** The saved relay port of the open workspace (as when the app launches and auto-starts the relay); if it cannot be read → the relay port currently remembered. */
function workspaceRelayPort(): number | undefined {
    try {
        const ws = require('../../../utils/app/WorkspaceManager').default.getInstance().getActiveWorkspace();
        const port = Number(ws?.relayPort);
        if (ws?.type !== 'remote' && Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch { /* WorkspaceManager not ready yet */ }
    return undefined;
}

/**
 * Starts the old-style tunnel of a service: exactly the functions that relay:startTunnel / tunnel:start / workflow:startTunnel call.
 * Runs only when NOT in 'cloudflare_auto' (the manager checks it inside the queue), so those functions do not call setServiceEnabled back.
 */
async function startLegacyTunnel(service: TunnelServiceId): Promise<void> {
    if (service === 'relay') {
        const relay = require('../../http/HttpRelayService').default.getInstance();
        if (!relay.isRunning()) {
            // Same as the quick switch in Settings → Employees: the employee server (LAN) is not running → start it first (relay:startServer)
            const port: number = workspaceRelayPort() ?? (Number(relay.getStatus().port) || defaultServicePort('relay'));
            const started = await relay.start(port);
            if (!started?.success) {
                throw new CloudError(
                    'RELAY_NOT_RUNNING',
                    tr('Bật máy chủ nhân viên (LAN) trước: chưa bật được trên cổng {{port}}{{v1}}. Kiểm tra ở Cài đặt → Nhân viên → Kết nối rồi thử lại.', { port, v1: started?.error ? ` (${started.error})` : '' }),
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
        throw new CloudError('GATEWAY_NOT_RUNNING', tr('Máy chủ nhận webhook workflow (cổng {{port}}) chưa chạy — khởi động lại Deplao rồi thử lại', { port: status.port }));
    }
    const res = await gateway.startTunnel();
    if (!res?.success) throw legacyFailure(service, true, res?.error);
}

/** Stops the old-style tunnel of a service (relay:stopTunnel / tunnel:stop / workflow:stopTunnel). */
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
        if (!db) throw new CloudError('DB_UNAVAILABLE', tr('Chưa đọc được dữ liệu workspace — thử lại sau'));
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

/** Whether the mode is 'cloudflare_auto' (reads cloud-settings; error → false = run as before). */
export function isCloudTunnelAuto(): boolean {
    try {
        return cloudflare.settings.get()?.tunnel?.mode === 'cloudflare_auto';
    } catch {
        return false;
    }
}

/** Listens for address / process changes (relay, integrationIpc). Returns an unsubscribe function. */
export function onCloudTunnelChange(cb: () => void): () => void {
    return manager.subscribe(cb);
}

/** Details of the shared cloudflared process (restarts, attempt, nextRetryAt…); null when it is not running. */
export function cloudTunnelProcessInfo(): RunnerSnapshot | null {
    return manager.processInfo();
}

export default cloudTunnel;
