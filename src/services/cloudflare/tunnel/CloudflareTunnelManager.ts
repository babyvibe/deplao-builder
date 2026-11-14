/**
 * CloudflareTunnelManager: "Cloudflare tự động" (automatic Cloudflare): ONE tunnel per Boss machine, named `deplao-<machine-name>-<4 characters of machineId>`,
 * created through the API with config_src 'cloudflare' (the config lives at Cloudflare). ONE cloudflared process serves all three services
 * (relay 9900, payments 9888, workflow webhook 9889). Turning a service on / off only changes the ingress (PUT …/configurations),
 * without restarting the process; the process runs while at least 1 service is on. Ingress / DNS: ingress.ts, dns.ts.
 *
 * Injected dependencies (tests: src/__tests__/cloudflare/tunnelManager.test.ts):
 *   api      : CloudflareApi (budget ~100 requests / 5 minutes for the WHOLE app, so no wasted calls: remember the ingress already applied,
 *              the token is kept in RAM, the Cloudflare-side state is read at most every 10 minutes)
 *   settings : cloud-settings.json (the tunnel part: tunnelId, tunnelName, dnsRecordIds, enabled…)
 *   runner   : the cloudflared process (index.ts: TunnelService, restarts itself with backoff)
 *   clock    : time, for spacing out health checks
 *
 * API v4 flow: GET cfd_tunnel?name=…&is_deleted=false → if missing, POST {name, config_src:'cloudflare'} →
 * GET …/{id}/token → GET + PUT …/{id}/configurations (keeps the rules of other domains) → DNS for each name (dns.ts).
 * Tunnel deleted on the dashboard (404) → create it again, point DNS at the new tunnel, redo it once.
 *
 * Health: /ready of the local cloudflared (at most every 15 s, in the background while the process runs): 0 connections → address 'restarting';
 * on the Cloudflare side GET …/{id} (healthy/degraded/down/inactive) + …/{id}/connections + DNS records still pointing at this machine,
 * at most every 10 minutes; the Check button (refresh) at most every 30 s.
 * A "foreign" connector = a connector whose id differs from this machine's connector (the id comes from the "Generated Connector ID" log line or the JSON
 * /ready of cloudflared). If our own id is not known yet, treat one connector as ours (the extra count = the rest).
 *
 * Other modes (temporary address / ngrok / manual Cloudflare): Cloudflare is not called. The address mirrors the old-style tunnel of
 * each port; turning a service on / off = turning that old-style tunnel on / off through the `legacy` bridge (index.ts); "Tự bật khi mở app" (start on app launch) =
 * relay_tunnel_autostart of the relay.
 *
 * All changing operations run one after another (queue): the UI, the relay's auto-start and init() do not step on each other.
 */
import { CloudError, type CloudflareApi, type CloudSettingsData, type CloudSettingsStore, type CloudTunnelModule } from '../contracts';
import type {
    AddressLayout, PublicAddress, TunnelAutoConfig, TunnelConfigView, TunnelHealth, TunnelMode, TunnelServiceId,
} from '../../../shared/cloud/cloudContracts';
import {
    addressFor, buildIngress, distinctHostnames, hostnameFor, hostnamesFor, hostPrefixError, ingressKey, isTunnelService,
    legacyAddressFor, normalizeHostname, TUNNEL_SERVICES,
    type LegacyTunnelState, type ProcessState, type ServicePorts,
} from './ingress';
import { ensureRecords, inspectOwnership, removeRecords } from './dns';
import { tr } from '../../../shared/i18n';

/** Local cloudflared /ready: at most once every 15 s. */
export const LOCAL_READY_MIN_INTERVAL_MS = 15_000;
/** Cloudflare-side state + connectors: at most once every 10 minutes (API budget). */
export const CF_STATUS_MIN_INTERVAL_MS = 10 * 60_000;
/** The "Kiểm tra" (Check) click (health({ refresh: true })): still spaced at least 30 s apart. */
export const CF_STATUS_REFRESH_MIN_INTERVAL_MS = 30_000;
/** A failed Cloudflare-side read → retry after 1 minute instead of 10 minutes. */
const CF_STATUS_RETRY_AFTER_ERROR_MS = 60_000;

type TunnelSettings = CloudSettingsData['tunnel'];

const TUNNEL_MODES: readonly TunnelMode[] = ['quick', 'ngrok', 'cloudflare_auto', 'cloudflare_manual'];
const NO_SERVICES: Record<TunnelServiceId, boolean> = { relay: false, payments: false, workflow: false };

// ─── cloudflared process (runner) ─────────────────────────────────────────

export interface RunnerSnapshot {
    /** The tunnel the running process serves (null if unknown). */
    tunnelId: string | null;
    state: 'starting' | 'active' | 'restarting';
    lastError: string | null;
    restarts: number;
    attempt: number;
    nextRetryAt: number | null;
    /** Metrics port (127.0.0.1): /ready, /metrics. */
    metricsPort: number | null;
    /** Connector ID of this process (read from the cloudflared log). */
    connectorId: string | null;
    version: string | null;
}

/** cloudflared JSON /ready: {"status":200,"readyConnections":4,"connectorId":"…"} (503 when 0 connections). */
export interface ReadyInfo {
    ready: boolean;
    readyConnections: number;
    connectorId: string | null;
}

export interface RunnerStartInput {
    tunnelId: string;
    token: string;
    /** Main address (relay): for display / logs only; the ingress lives at Cloudflare. */
    publicUrl: string;
}

export interface CloudTunnelRunner {
    /** Starts the process; resolves when the first connection is up. An error → reject, but it still retries in the background (keepAlive). */
    start(input: RunnerStartInput): Promise<void>;
    /** Switching to another tunnel does not interrupt service (make-before-break). */
    replace(input: RunnerStartInput): Promise<void>;
    stop(): Promise<void>;
    snapshot(): RunnerSnapshot | null;
    /** GET http://127.0.0.1:<metrics>/ready; null when the port is not known yet / cannot be read. */
    readiness(): Promise<ReadyInfo | null>;
    onChange(cb: () => void): () => void;
}

/** Bridge to the old-style tunnel (Quick / ngrok / manual Cloudflare) when not in automatic mode. */
export interface LegacyTunnelBridge {
    state(service: TunnelServiceId): LegacyTunnelState | null;
    /** Mode derived from the old relay config (relay_tunnel_provider), null if it cannot be read. */
    mode?(): TunnelMode | null;
    /** Writes the old mode down to the relay config (so the relay uses the right provider). */
    setMode?(mode: TunnelMode): void;
    /**
     * Turns the old-style tunnel of a service on / off, through the old path (index.ts: relay → HttpRelayService.startTunnel /
     * stopTunnel, payments → PaymentsTunnel, workflow → WebhookGatewayService). An error → throws CloudError (the message shown to the user).
     * It must not call back into the tunnel module (it runs inside the manager's queue).
     */
    start?(service: TunnelServiceId): Promise<void>;
    stop?(service: TunnelServiceId): Promise<void>;
    /** "Tự bật khi mở app" (start on app launch) of the old-style tunnel (relay_tunnel_autostart), null if it cannot be read. */
    autoStart?(): boolean | null;
    setAutoStart?(on: boolean): void;
}

export interface TunnelManagerDeps {
    api: () => CloudflareApi;
    settings: Pick<CloudSettingsStore, 'get' | 'update'>;
    runner: CloudTunnelRunner;
    clock?: { now(): number };
    /** Reports a change (index.ts: cloudflare.notifyChanged('tunnel')). */
    notify?: () => void;
    /** The real port of each service (default 9900/9888/9889). */
    ports?: () => ServicePorts;
    legacy?: LegacyTunnelBridge;
    log?: { log(message: string): void; warn(message: string): void };
    /** Background /ready reads while cloudflared runs (ms); 0 / empty = off (tests). */
    readyPollMs?: number;
}

interface ConnectorInfo {
    id: string;
    version: string | null;
    /** Number of open connections (not counting ones waiting to reconnect). */
    conns: number;
    originIp: string | null;
}

interface CloudSnapshot {
    tunnelId: string;
    /** The most recent read. */
    at: number;
    /** Read again from this time on. */
    nextAt: number;
    status: string | null;
    connectors: ConnectorInfo[];
    error: string | null;
}

// ─── Pure functions ───────────────────────────────────────────────────────────────

function errorText(err: unknown): string {
    return (err as any)?.message || String(err);
}

function isNotFound(err: unknown): boolean {
    return (err as any)?.status === 404;
}

/** `deplao-<machine name as a slug>-<first 4 characters of machineId>`, e.g. deplao-may-ban-hang-ab12. */
export function tunnelNameFor(machineName: string | null | undefined, machineId: string | null | undefined): string {
    const slug = String(machineName ?? '')
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .replace(/[đĐ]/g, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32)
        .replace(/-+$/, '') || 'may';
    const suffix = String(machineId ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || '0000';
    return `deplao-${slug}-${suffix}`;
}

/** The tunnel part of cloud-settings.json, with defaults filled in for missing fields. */
export function normalizeTunnelSettings(raw: Partial<TunnelSettings> | null | undefined): TunnelSettings {
    const t: Partial<TunnelSettings> = raw && typeof raw === 'object' ? raw : {};
    const enabled = (t.enabled && typeof t.enabled === 'object' ? t.enabled : {}) as Partial<Record<TunnelServiceId, boolean>>;
    return {
        mode: TUNNEL_MODES.includes(t.mode as TunnelMode) ? (t.mode as TunnelMode) : 'quick',
        auto: t.auto && typeof t.auto === 'object' ? { ...t.auto } : null,
        autoStart: !!t.autoStart,
        tunnelId: typeof t.tunnelId === 'string' && t.tunnelId ? t.tunnelId : null,
        tunnelName: typeof t.tunnelName === 'string' && t.tunnelName ? t.tunnelName : null,
        dnsRecordIds: t.dnsRecordIds && typeof t.dnsRecordIds === 'object' ? { ...t.dnsRecordIds } : {},
        enabled: { relay: !!enabled.relay, payments: !!enabled.payments, workflow: !!enabled.workflow },
    };
}

/** Checks and normalizes the config the user enters. An error → CloudError('INVALID_INPUT'). */
export function normalizeAutoInput(input: TunnelAutoConfig): TunnelAutoConfig {
    const zoneId = String(input?.zoneId ?? '').trim();
    const zoneName = normalizeHostname(input?.zoneName);
    const hostPrefix = normalizeHostname(input?.hostPrefix);
    const layout: AddressLayout = input?.layout === 'split' ? 'split' : 'single';
    if (!zoneId || !zoneName) throw new CloudError('INVALID_INPUT', tr('Chọn tên miền (zone) trong tài khoản Cloudflare'));
    const prefixError = hostPrefixError(hostPrefix);
    if (prefixError) throw new CloudError('INVALID_INPUT', prefixError);
    return { zoneId, zoneName, hostPrefix, layout };
}

function parseConnectors(raw: unknown): ConnectorInfo[] {
    if (!Array.isArray(raw)) return [];
    const list: ConnectorInfo[] = [];
    for (const item of raw as any[]) {
        if (!item || typeof item !== 'object') continue;
        const conns: any[] | null = Array.isArray(item.conns) ? item.conns : null;
        const id = String(item.id || item.client_id || conns?.[0]?.client_id || '').trim();
        if (!id) continue;
        list.push({
            id,
            version: item.version || conns?.[0]?.client_version || null,
            // No conns list → treat the connector as active
            conns: conns ? conns.filter((c) => c && !c.is_pending_reconnect).length : 1,
            originIp: conns?.[0]?.origin_ip || null,
        });
    }
    return list;
}

function blockedKey(map: Map<string, string>): string {
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('|');
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class CloudflareTunnelManager implements CloudTunnelModule {
    private queue: Promise<unknown> = Promise.resolve();
    /** The tunnel token is kept only in RAM (fetched again on each app launch: 1 request). */
    private tokenCache: { tunnelId: string; token: string } | null = null;
    /** Ingress applied in this session (tunnel + Deplao's rules): if it matches, do not GET/PUT again. */
    private appliedIngress: string | null = null;
    /** The most recent error when allocating / starting the process. */
    private lastError: string | null = null;
    /** Domains that are blocked (DNS points at another machine / the record is gone) → notify. */
    private blocked = new Map<string, string>();
    private local: { at: number; info: ReadyInfo | null } | null = null;
    private localInFlight: Promise<void> | null = null;
    private cloud: CloudSnapshot | null = null;
    private cloudInFlight: Promise<void> | null = null;
    private readyTimer: ReturnType<typeof setInterval> | null = null;
    private readonly listeners = new Set<() => void>();
    private readonly log: { log(message: string): void; warn(message: string): void };

    constructor(private readonly deps: TunnelManagerDeps) {
        this.log = deps.log ?? { log: () => undefined, warn: () => undefined };
        deps.runner.onChange(() => this.onRunnerChange());
    }

    // ─── CloudTunnelModule ──────────────────────────────────────────────

    async init(): Promise<void> {
        try {
            await this.run(async () => {
                const t = this.tunnel();
                if (t.mode !== 'cloudflare_auto' || !t.auto || !t.autoStart || !this.anyEnabled()) return;
                this.log.log(`[CloudTunnel] Tự bật địa chỉ Cloudflare cho: ${this.enabledServices().join(', ')}`);
                await this.provisionAndRun();
                this.lastError = null;
            });
        } catch (err) {
            this.lastError = errorText(err);
            this.log.warn(`[CloudTunnel] Không tự bật được địa chỉ Cloudflare: ${this.lastError}`);
        } finally {
            this.changed();
        }
    }

    getConfig(): TunnelConfigView {
        const t = this.tunnel();
        const mode = this.effectiveMode(t);
        return {
            mode,
            auto: t.auto ? { ...t.auto } : null,
            // Automatic Cloudflare: cloud-settings; other modes: the relay's "Tự bật tunnel khi mở app" (start tunnel on app launch) (relay_tunnel_autostart)
            autoStart: mode === 'cloudflare_auto' ? t.autoStart : this.legacyAutoStart(t.autoStart),
            preview: t.auto ? hostnamesFor(t.auto) : { relay: '', payments: '', workflow: '' },
        };
    }

    async setMode(mode: TunnelMode): Promise<TunnelConfigView> {
        if (!TUNNEL_MODES.includes(mode)) throw new CloudError('INVALID_INPUT', tr('Cách tạo địa chỉ không hợp lệ'));
        return this.run(async () => {
            const previous = this.tunnel().mode;
            this.patchTunnel((t) => { t.mode = mode; });
            try {
                if (mode !== 'cloudflare_auto') {
                    // Quick / ngrok / manual: the relay reads relay_tunnel_provider as before → write the new choice
                    try { this.deps.legacy?.setMode?.(mode); } catch (err) { this.log.warn(`[CloudTunnel] Không ghi được nhà cung cấp tunnel của relay: ${errorText(err)}`); }
                    if (previous === 'cloudflare_auto' || this.deps.runner.snapshot()) await this.stopProcess();
                } else if (this.tunnel().auto && this.anyEnabled()) {
                    try {
                        await this.provisionAndRun();
                        this.lastError = null;
                    } catch (err) {
                        this.lastError = errorText(err);
                        this.log.warn(`[CloudTunnel] Đã chọn Cloudflare tự động nhưng chưa bật được: ${this.lastError}`);
                    }
                }
            } finally {
                this.changed();
            }
            return this.getConfig();
        });
    }

    async configureAuto(input: TunnelAutoConfig): Promise<{ config: TunnelConfigView; addresses: PublicAddress[] }> {
        const next = normalizeAutoInput(input);
        return this.run(async () => {
            const before = this.tunnel();
            const previousHosts = Object.keys(before.dnsRecordIds).map(normalizeHostname);
            const previousZoneId = before.auto?.zoneId ?? null;
            // First configuration on this machine: the service switches follow initialServices() (the cloud-settings default turns all three on)
            const seeded = before.auto ? null : this.initialServices();
            try {
                const tunnelId = await this.ensureTunnel(false);
                const hosts = distinctHostnames(next);
                // Check DNS conflicts for EVERY name before writing (DNS_CONFLICT → change nothing)
                const { recordIds, patched } = await ensureRecords(this.api(), next.zoneId, hosts, tunnelId);
                if (patched.length) this.log.log(`[CloudTunnel] Đã trỏ ${patched.join(', ')} về tunnel của máy này`);
                const removed = previousHosts.filter((host) => !hosts.includes(host));
                this.patchTunnel((t) => {
                    t.mode = 'cloudflare_auto';
                    t.auto = { ...next };
                    t.dnsRecordIds = { ...recordIds };
                    if (seeded) t.enabled = { ...seeded };
                });
                if (seeded) this.log.log(`[CloudTunnel] Dịch vụ bật mặc định: ${this.enabledServices().join(', ')}`);
                this.blocked.clear();
                this.cloud = null;
                await this.withTunnel(async (id, auto) => {
                    await this.applyIngress(id, auto, removed);
                    if (this.anyEnabled()) await this.ensureProcess(id, auto);
                    else await this.stopProcess();
                });
                if (removed.length && previousZoneId) await this.cleanupHosts(previousZoneId, tunnelId, removed);
                this.lastError = null;
                this.log.log(`[CloudTunnel] Đã cấu hình ${hosts.join(', ')} (${next.layout})`);
            } catch (err) {
                this.lastError = errorText(err);
                throw err;
            } finally {
                this.changed();
            }
            return { config: this.getConfig(), addresses: this.addresses() };
        });
    }

    async setAutoStart(on: boolean): Promise<void> {
        await this.run(async () => {
            const legacy = this.deps.legacy;
            if (this.tunnel().mode !== 'cloudflare_auto' && legacy?.setAutoStart) {
                // Quick / ngrok / manual: the relay starts the tunnel by itself when running if relay_tunnel_autostart = '1' (old config).
                // Payments / workflow webhook have no auto-start in these modes (as before).
                try {
                    legacy.setAutoStart(!!on);
                } catch (err) {
                    throw err instanceof CloudError ? err : new CloudError('SETTINGS_WRITE_FAILED', tr('Không lưu được "Tự bật khi mở app": {{v1}}', { v1: errorText(err) }));
                }
                return;
            }
            this.patchTunnel((t) => { t.autoStart = !!on; });
        });
        this.changed();
    }

    async setServiceEnabled(service: TunnelServiceId, enabled: boolean): Promise<PublicAddress[]> {
        if (!isTunnelService(service)) throw new CloudError('INVALID_INPUT', tr('Dịch vụ không hợp lệ'));
        const on = !!enabled;
        return this.run(async () => {
            const t = this.tunnel();
            const before = { ...t.enabled };
            if (t.mode !== 'cloudflare_auto') {
                // Other modes: turn the service's old-style tunnel on / off through the old path (the legacy bridge in index.ts: relay:startTunnel,
                // tunnel:start, workflow:startTunnel), without calling Cloudflare. The switch is written only on success; the first automatic configuration
                // resets it to initialServices(). A bridge with no start/stop (old version) → only remember the choice.
                const legacy = this.deps.legacy;
                try {
                    if (on) await legacy?.start?.(service);
                    else await legacy?.stop?.(service);
                    this.patchTunnel((s) => { s.enabled[service] = on; });
                } catch (err) {
                    this.log.warn(`[CloudTunnel] Không ${on ? 'bật' : 'tắt'} được tunnel kiểu cũ của ${service}: ${errorText(err)}`);
                    throw err instanceof CloudError
                        ? err
                        : new CloudError(on ? 'TUNNEL_START_FAILED' : 'TUNNEL_STOP_FAILED', tr('Không {{v1}} được địa chỉ: {{v2}}', { v1: on ? tr('bật') : tr('tắt'), v2: errorText(err) }));
                } finally {
                    this.changed();
                }
                return this.addresses();
            }
            if (on && !t.auto) throw new CloudError('NOT_CONFIGURED', tr('Chưa cấu hình địa chỉ Cloudflare tự động (chọn tên miền và tên)'));
            this.patchTunnel((s) => { s.enabled[service] = on; });
            try {
                if (!t.auto) {
                    if (!this.anyEnabled()) await this.stopProcess();
                } else if (this.anyEnabled()) {
                    await this.provisionAndRun();
                } else {
                    // Turning off the last service: stop the process first (stops serving at once); the ingress is updated afterwards, an API error does not block turning off
                    await this.stopProcess();
                    try {
                        await this.withTunnel((id, auto) => this.applyIngress(id, auto));
                    } catch (err) {
                        this.log.warn(`[CloudTunnel] Đã dừng cloudflared nhưng chưa cập nhật được ingress: ${errorText(err)}`);
                    }
                }
                this.lastError = null;
            } catch (err) {
                // Could not apply → restore the old switch so the UI does not show a wrong state
                this.patchTunnel((s) => { s.enabled = { ...NO_SERVICES, ...before }; });
                this.lastError = errorText(err);
                throw err;
            } finally {
                this.changed();
            }
            return this.addresses();
        });
    }

    addresses(): PublicAddress[] {
        return TUNNEL_SERVICES.map((service) => this.addressOf(service));
    }

    addressOf(service: TunnelServiceId): PublicAddress {
        const t = this.tunnel();
        const mode = this.effectiveMode(t);
        if (mode !== 'cloudflare_auto') {
            let legacy: LegacyTunnelState | null = null;
            try { legacy = this.deps.legacy?.state(service) ?? null; } catch { legacy = null; }
            return legacyAddressFor(service, mode, legacy);
        }
        const snap = this.deps.runner.snapshot();
        let process: ProcessState = snap ? snap.state : 'stopped';
        let error: string | null = this.lastError ?? snap?.lastError ?? null;
        // Process still alive but /ready reports 0 connections (network lost…) → cloudflared is reconnecting by itself
        if (process === 'active' && this.local?.info && !this.local.info.ready) {
            process = 'restarting';
            error = tr('cloudflared mất kết nối tới Cloudflare — đang tự kết nối lại');
        }
        const blocked = t.auto ? this.blocked.get(hostnameFor(t.auto, service)) ?? null : null;
        return addressFor(service, t.auto, { mode, enabled: !!t.enabled[service], process, error, blocked });
    }

    /** opts.refresh = the user clicked Check: read the Cloudflare side again (still spaced ≥ 30 s apart). */
    async health(opts: { refresh?: boolean } = {}): Promise<TunnelHealth> {
        const now = this.now();
        await Promise.all([this.refreshLocal(now), this.refreshCloud(now, !!opts.refresh)]);
        return this.healthView();
    }

    async moveHere(): Promise<PublicAddress[]> {
        return this.run(async () => {
            this.requireAuto();
            try {
                await this.provisionAndRun({ forceOwnTunnel: true, checkDns: true });
                this.blocked.clear();
                this.cloud = null;
                this.lastError = null;
                this.log.log('[CloudTunnel] Đã chuyển địa chỉ cố định về máy này');
            } catch (err) {
                this.lastError = errorText(err);
                throw err;
            } finally {
                this.changed();
            }
            return this.addresses();
        });
    }

    async disconnectForeign(): Promise<void> {
        return this.run(async () => {
            const t = this.tunnel();
            if (!t.tunnelId) return;
            const snap = this.deps.runner.snapshot();
            let ourId = snap?.connectorId || this.local?.info?.connectorId || null;
            if (snap && !ourId) {
                const info = await this.deps.runner.readiness().catch(() => null);
                if (info) this.local = { at: this.now(), info };
                ourId = info?.connectorId || null;
            }
            // If we do not know which connector is this machine's, do not delete any (avoids cutting ourselves off)
            if (snap && !ourId) throw new CloudError('UNKNOWN_CONNECTOR', tr('Chưa xác định được kết nối của máy này — thử lại sau vài giây'));
            const api = this.api();
            const path = `/accounts/${this.accountId()}/cfd_tunnel/${t.tunnelId}/connections`;
            const foreign = parseConnectors(await api.request<any[]>('GET', path)).filter((c) => c.id !== ourId);
            for (const connector of foreign) {
                await api.request('DELETE', path, {}, { query: { client_id: connector.id } });
            }
            if (foreign.length) this.log.log(`[CloudTunnel] Đã ngắt ${foreign.length} connector của máy khác`);
            this.cloud = null;
            this.changed();
        });
    }

    async teardown(): Promise<void> {
        return this.run(async () => {
            const t = this.tunnel();
            try {
                await this.stopProcess();
                if (t.tunnelId) {
                    const api = this.api();
                    const base = `/accounts/${this.accountId()}/cfd_tunnel/${t.tunnelId}`;
                    // Order: clean up connections → delete the tunnel → delete the DNS records that carry the comment deplao:<id>
                    await this.ignoreNotFound(() => api.request('DELETE', `${base}/connections`, {}));
                    await this.ignoreNotFound(() => api.request('DELETE', base, {}));
                    if (t.auto?.zoneId) {
                        const removed = await removeRecords(api, t.auto.zoneId, t.tunnelId, { hostnames: Object.keys(t.dnsRecordIds) });
                        if (removed.length) this.log.log(`[CloudTunnel] Đã xoá bản ghi DNS: ${removed.join(', ')}`);
                    }
                    this.log.log(`[CloudTunnel] Đã gỡ tunnel ${t.tunnelName || t.tunnelId}`);
                }
                this.patchTunnel((s) => {
                    s.tunnelId = null;
                    s.tunnelName = null;
                    s.dnsRecordIds = {};
                    s.enabled = { ...NO_SERVICES };
                });
                this.tokenCache = null;
                this.appliedIngress = null;
                this.cloud = null;
                this.local = null;
                this.blocked.clear();
                this.lastError = null;
            } finally {
                this.changed();
            }
        });
    }

    async shutdown(): Promise<void> {
        if (this.readyTimer) {
            clearInterval(this.readyTimer);
            this.readyTimer = null;
        }
        // Not through the queue: an operation waiting for a connection (≤ 30 s) must not keep the app from quitting
        try { await this.deps.runner.stop(); } catch { /* already stopped */ }
    }

    // ─── Outside the contract (used by relay / IPC) ──────────────────────────────

    /** Listens to every change (on/off, process up/down, health changes). Returns an unsubscribe function. */
    subscribe(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }

    /** Details of the shared cloudflared process (null when it is not running). */
    processInfo(): RunnerSnapshot | null {
        return this.deps.runner.snapshot();
    }

    isAutoMode(): boolean {
        return this.tunnel().mode === 'cloudflare_auto';
    }

    // ─── Provisioning ───────────────────────────────────────────────────────

    /** The machine's tunnel + DNS + ingress per the saved config, then start / stop cloudflared per the services that are on. */
    private async provisionAndRun(opts: { forceOwnTunnel?: boolean; checkDns?: boolean } = {}): Promise<void> {
        await this.withTunnel(async (tunnelId, auto) => {
            await this.applyIngress(tunnelId, auto);
            if (this.anyEnabled()) await this.ensureProcess(tunnelId, auto);
            else await this.stopProcess();
        }, opts);
    }

    /** Runs fn with a valid tunnel; tunnel deleted on Cloudflare (404) → create it again, fix DNS, run once more. */
    private async withTunnel(
        fn: (tunnelId: string, auto: TunnelAutoConfig) => Promise<void>,
        opts: { forceOwnTunnel?: boolean; checkDns?: boolean } = {},
    ): Promise<void> {
        const auto = this.requireAuto();
        let tunnelId = await this.ensureTunnel(!!opts.forceOwnTunnel);
        await this.ensureDns(tunnelId, auto, !!opts.checkDns);
        try {
            await fn(tunnelId, auto);
        } catch (err) {
            if (!isNotFound(err)) throw err;
            this.log.warn(`[CloudTunnel] Tunnel ${tunnelId} không còn trên Cloudflare — tạo lại`);
            this.forgetTunnel();
            tunnelId = await this.ensureTunnel(!!opts.forceOwnTunnel);
            await this.ensureDns(tunnelId, auto, true);
            await fn(tunnelId, auto);
        }
    }

    /**
     * This machine's tunnel: uses the saved tunnel (renaming the machine does not create a new tunnel); forceOwn (moveHere) → must be
     * exactly this machine's name. Looks it up by name first; if none exists, creates it (config_src 'cloudflare').
     */
    private async ensureTunnel(forceOwn: boolean): Promise<string> {
        const t = this.tunnel();
        const expected = this.expectedTunnelName();
        if (t.tunnelId && (!forceOwn || t.tunnelName === expected)) return t.tunnelId;
        const account = this.accountId();
        const api = this.api();
        const list = await api.request<any[]>('GET', `/accounts/${account}/cfd_tunnel`, undefined, {
            query: { name: expected, is_deleted: false },
        });
        const found = (Array.isArray(list) ? list : []).find((x) => x && x.name === expected && !x.deleted_at && typeof x.id === 'string');
        let tunnelId: string;
        if (found) {
            tunnelId = found.id;
            this.log.log(`[CloudTunnel] Dùng lại tunnel ${expected} (${tunnelId})`);
        } else {
            const created = await api.request<any>('POST', `/accounts/${account}/cfd_tunnel`, { name: expected, config_src: 'cloudflare' });
            if (!created || typeof created.id !== 'string' || !created.id) {
                throw new CloudError('TUNNEL_CREATE_FAILED', tr('Cloudflare không trả về tunnel vừa tạo'));
            }
            tunnelId = created.id;
            if (typeof created.token === 'string' && created.token.trim()) this.tokenCache = { tunnelId, token: created.token.trim() };
            this.log.log(`[CloudTunnel] Đã tạo tunnel ${expected} (${tunnelId})`);
        }
        this.patchTunnel((s) => {
            s.tunnelId = tunnelId;
            s.tunnelName = expected;
        });
        this.appliedIngress = null;
        this.cloud = null;
        return tunnelId;
    }

    private forgetTunnel(): void {
        this.patchTunnel((s) => {
            s.tunnelId = null;
            s.tunnelName = null;
        });
        this.tokenCache = null;
        this.appliedIngress = null;
        this.cloud = null;
    }

    /** DNS records for every name of the layout (skipped when all ids are saved, unless force). */
    private async ensureDns(tunnelId: string, auto: TunnelAutoConfig, force: boolean): Promise<void> {
        const hosts = distinctHostnames(auto);
        const stored = this.tunnel().dnsRecordIds;
        if (!force && hosts.every((host) => stored[host])) return;
        const { recordIds, patched } = await ensureRecords(this.api(), auto.zoneId, hosts, tunnelId);
        if (patched.length) this.log.log(`[CloudTunnel] Đã trỏ ${patched.join(', ')} về tunnel của máy này`);
        this.patchTunnel((s) => { s.dnsRecordIds = { ...s.dnsRecordIds, ...recordIds }; });
        for (const host of hosts) this.blocked.delete(host);
    }

    /** DNS records of the old names (prefix / layout / zone changed): errors are only logged. */
    private async cleanupHosts(zoneId: string, tunnelId: string, hosts: string[]): Promise<void> {
        try {
            const removed = await removeRecords(this.api(), zoneId, tunnelId, { hostnames: hosts, sweep: false });
            if (removed.length) this.log.log(`[CloudTunnel] Đã xoá bản ghi DNS cũ: ${removed.join(', ')}`);
        } catch (err) {
            this.log.warn(`[CloudTunnel] Chưa xoá được bản ghi DNS cũ (${hosts.join(', ')}): ${errorText(err)}`);
        }
    }

    /** GET the current config, then PUT (PUT replaces the WHOLE config): keeps the rules of other domains; identical → no PUT. */
    private async applyIngress(tunnelId: string, auto: TunnelAutoConfig, extraManaged: string[] = []): Promise<void> {
        const enabled = this.tunnel().enabled;
        const ports = this.ports();
        const managedHosts = Array.from(new Set([...Object.keys(this.tunnel().dnsRecordIds), ...extraManaged].map(normalizeHostname)));
        const ours = buildIngress(auto.layout, auto.hostPrefix, auto.zoneName, enabled, [], { ports, managedHosts });
        const key = `${tunnelId}|${ingressKey(ours)}|${managedHosts.sort().join(',')}`;
        if (this.appliedIngress === key) return; // already applied in this session: costs no request
        const api = this.api();
        const path = `/accounts/${this.accountId()}/cfd_tunnel/${tunnelId}/configurations`;
        const current = await api.request<any>('GET', path);
        const currentConfig: Record<string, unknown> = current && current.config && typeof current.config === 'object' ? current.config : {};
        const ingress = buildIngress(auto.layout, auto.hostPrefix, auto.zoneName, enabled, currentConfig.ingress, { ports, managedHosts });
        if (ingressKey(ingress) !== ingressKey(currentConfig.ingress)) {
            await api.request('PUT', path, { config: { ...currentConfig, ingress } });
            this.log.log(`[CloudTunnel] Đã cập nhật ingress (${this.enabledServices().join(', ') || 'không dịch vụ nào'})`);
        }
        this.appliedIngress = key;
    }

    private async fetchToken(tunnelId: string): Promise<string> {
        if (this.tokenCache?.tunnelId === tunnelId) return this.tokenCache.token;
        const token = await this.api().request<string>('GET', `/accounts/${this.accountId()}/cfd_tunnel/${tunnelId}/token`);
        if (typeof token !== 'string' || !token.trim()) throw new CloudError('TUNNEL_TOKEN_MISSING', tr('Cloudflare không trả token của tunnel'));
        this.tokenCache = { tunnelId, token: token.trim() };
        return this.tokenCache.token;
    }

    /** cloudflared runs for the right tunnel: not running → start; running another tunnel → switch without interrupting; already right → nothing. */
    private async ensureProcess(tunnelId: string, auto: TunnelAutoConfig): Promise<void> {
        const snap = this.deps.runner.snapshot();
        if (snap && snap.tunnelId === tunnelId) return;
        const input: RunnerStartInput = { tunnelId, token: await this.fetchToken(tunnelId), publicUrl: `https://${hostnameFor(auto, 'relay')}` };
        try {
            if (snap) await this.deps.runner.replace(input);
            else await this.deps.runner.start(input);
            this.lastError = null;
        } catch (err) {
            // The process retries in the background (keepAlive): the error is reported on the address, it does not break the configuration step
            this.lastError = errorText(err);
            this.log.warn(`[CloudTunnel] cloudflared chưa kết nối được: ${this.lastError} — đang tự thử lại`);
        }
    }

    private async stopProcess(): Promise<void> {
        this.local = null;
        await this.deps.runner.stop();
    }

    // ─── Health ───────────────────────────────────────────────────────

    private refreshLocal(now: number): Promise<void> {
        if (!this.deps.runner.snapshot()) {
            this.local = null;
            return Promise.resolve();
        }
        if (this.local && now - this.local.at < LOCAL_READY_MIN_INTERVAL_MS) return Promise.resolve();
        if (this.localInFlight) return this.localInFlight;
        this.localInFlight = (async () => {
            let info: ReadyInfo | null = null;
            try { info = await this.deps.runner.readiness(); } catch { info = null; }
            this.local = { at: now, info };
        })().finally(() => { this.localInFlight = null; });
        return this.localInFlight;
    }

    private refreshCloud(now: number, force: boolean): Promise<void> {
        const t = this.tunnel();
        if (!t.tunnelId || t.mode !== 'cloudflare_auto') return Promise.resolve();
        const last = this.cloud && this.cloud.tunnelId === t.tunnelId ? this.cloud : null;
        const due = !last || now >= last.nextAt || (force && now - last.at >= CF_STATUS_REFRESH_MIN_INTERVAL_MS);
        if (!due) return Promise.resolve();
        if (this.cloudInFlight) return this.cloudInFlight;
        const tunnelId = t.tunnelId;
        const auto = t.auto;
        this.cloudInFlight = (async () => {
            try {
                const api = this.api();
                const base = `/accounts/${this.accountId()}/cfd_tunnel/${tunnelId}`;
                const tunnel = await api.request<any>('GET', base);
                const connections = await api.request<any[]>('GET', `${base}/connections`);
                const blocked = new Map<string, string>();
                if (auto?.zoneId) {
                    const owners = await inspectOwnership(api, auto.zoneId, distinctHostnames(auto), tunnelId);
                    for (const [host, owner] of Object.entries(owners)) {
                        if (owner === 'elsewhere') blocked.set(host, tr('Tên {{host}} đang trỏ sang máy khác — chọn "Chuyển địa chỉ về máy này" để dùng máy này', { host }));
                        else if (owner === 'missing') blocked.set(host, tr('Bản ghi DNS của {{host}} không còn — chọn "Chuyển địa chỉ về máy này" để tạo lại', { host }));
                    }
                }
                const status = typeof tunnel?.status === 'string' ? tunnel.status : null;
                const changed = blockedKey(blocked) !== blockedKey(this.blocked) || status !== (last?.status ?? null);
                this.blocked = blocked;
                this.cloud = { tunnelId, at: now, nextAt: now + CF_STATUS_MIN_INTERVAL_MS, status, connectors: parseConnectors(connections), error: null };
                if (changed) this.changed();
            } catch (err) {
                const message = errorText(err);
                this.cloud = {
                    tunnelId,
                    at: now,
                    nextAt: now + CF_STATUS_RETRY_AFTER_ERROR_MS,
                    status: isNotFound(err) ? 'not_found' : last?.status ?? null,
                    connectors: last?.connectors ?? [],
                    error: message,
                };
                this.log.warn(`[CloudTunnel] Không đọc được trạng thái tunnel phía Cloudflare: ${message}`);
            } finally {
                this.cloudInFlight = null;
            }
        })();
        return this.cloudInFlight;
    }

    private healthView(): TunnelHealth {
        const t = this.tunnel();
        const snap = this.deps.runner.snapshot();
        const info = snap ? this.local?.info ?? null : null;
        const cloud = this.cloud && this.cloud.tunnelId === t.tunnelId ? this.cloud : null;
        const ourId = snap?.connectorId || info?.connectorId || null;
        const active = (cloud?.connectors ?? []).filter((c) => c.conns > 0);
        const own = ourId ? active.find((c) => c.id === ourId) ?? null : null;
        let foreign = 0;
        if (cloud) {
            if (!snap) foreign = active.length; // this machine does not run cloudflared → every connector belongs to another machine
            else if (ourId) foreign = active.filter((c) => c.id !== ourId).length;
            else foreign = Math.max(0, active.length - 1); // own id not known yet: treat one connector as this machine's
        }
        const times = [snap ? this.local?.at : undefined, cloud?.at].filter((x): x is number => typeof x === 'number');
        return {
            tunnelId: t.tunnelId,
            tunnelName: t.tunnelName,
            cfStatus: cloud?.status ?? null,
            localReady: !!info?.ready,
            connections: info ? info.readyConnections : own?.conns ?? 0,
            foreignConnectors: foreign,
            cloudflaredVersion: snap?.version ?? own?.version ?? null,
            checkedAt: times.length ? Math.max(...times) : null,
        };
    }

    private onRunnerChange(): void {
        this.local = null;
        this.syncReadyPoll();
        this.changed();
    }

    /** Background /ready read while the process runs: 0 connections → the address shows 'restarting' (costs no API budget). */
    private syncReadyPoll(): void {
        const ms = this.deps.readyPollMs ?? 0;
        const running = !!this.deps.runner.snapshot();
        if (running && ms > 0 && !this.readyTimer) {
            this.readyTimer = setInterval(() => { void this.pollReady(); }, ms);
            (this.readyTimer as any)?.unref?.();
        } else if ((!running || !(ms > 0)) && this.readyTimer) {
            clearInterval(this.readyTimer);
            this.readyTimer = null;
        }
    }

    private async pollReady(): Promise<void> {
        const before = this.local?.info?.ready ?? null;
        await this.refreshLocal(this.now());
        const after = this.local?.info?.ready ?? null;
        if (before !== after) this.changed();
    }

    // ─── Utilities ───────────────────────────────────────────────────────

    private run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.queue.then(task, task);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private changed(): void {
        try { this.deps.notify?.(); } catch { /* renderer not ready yet */ }
        for (const cb of Array.from(this.listeners)) {
            try { cb(); } catch (err) { this.log.warn(`[CloudTunnel] listener lỗi: ${errorText(err)}`); }
        }
    }

    private async ignoreNotFound(call: () => Promise<unknown>): Promise<void> {
        try {
            await call();
        } catch (err) {
            if (!isNotFound(err)) throw err;
        }
    }

    private tunnel(): TunnelSettings {
        return normalizeTunnelSettings(this.deps.settings.get()?.tunnel);
    }

    private patchTunnel(mutate: (t: TunnelSettings) => void): void {
        this.deps.settings.update((draft) => {
            const t = normalizeTunnelSettings(draft.tunnel);
            mutate(t);
            // Keep unknown fields (cloud-settings keeps fields it does not know about when normalizing)
            const current = draft.tunnel && typeof draft.tunnel === 'object' ? draft.tunnel : {};
            draft.tunnel = { ...current, ...t };
        });
    }

    /**
     * Service switches for the first automatic configuration: relay on; payments / workflow webhook on only when their old-style tunnel
     * is already on (the user already opened that port to the Internet): never opens any extra port by itself.
     */
    private initialServices(): Record<TunnelServiceId, boolean> {
        const legacyOn = (service: TunnelServiceId): boolean => {
            try { return !!this.deps.legacy?.state(service); } catch { return false; }
        };
        return { relay: true, payments: legacyOn('payments'), workflow: legacyOn('workflow') };
    }

    /** "Tự bật khi mở app" (start on app launch) of the old-style tunnel; if it cannot be read (DB not open yet, old bridge) → the cloud-settings value. */
    private legacyAutoStart(fallback: boolean): boolean {
        try {
            const value = this.deps.legacy?.autoStart?.();
            if (typeof value === 'boolean') return value;
        } catch { /* DB not open yet */ }
        return fallback;
    }

    /** 'cloudflare_auto' per the setting; other modes derived from the old relay config (a change made in the old Settings still matches). */
    private effectiveMode(t: TunnelSettings): TunnelMode {
        if (t.mode === 'cloudflare_auto') return t.mode;
        try {
            const legacy = this.deps.legacy?.mode?.();
            if (legacy && legacy !== 'cloudflare_auto' && TUNNEL_MODES.includes(legacy)) return legacy;
        } catch { /* DB not open yet */ }
        return t.mode;
    }

    private anyEnabled(): boolean {
        return this.enabledServices().length > 0;
    }

    private enabledServices(): TunnelServiceId[] {
        const enabled = this.tunnel().enabled;
        return TUNNEL_SERVICES.filter((service) => enabled[service]);
    }

    private requireAuto(): TunnelAutoConfig {
        const auto = this.tunnel().auto;
        if (!auto) throw new CloudError('NOT_CONFIGURED', tr('Chưa cấu hình địa chỉ Cloudflare tự động (chọn tên miền và tên)'));
        return auto;
    }

    private accountId(): string {
        const id = this.deps.settings.get()?.accountId;
        if (!id) throw new CloudError('NOT_CONNECTED', tr('Chưa kết nối tài khoản Cloudflare'));
        return id;
    }

    private api(): CloudflareApi {
        return this.deps.api();
    }

    private ports(): ServicePorts {
        try { return this.deps.ports?.() ?? {}; } catch { return {}; }
    }

    private expectedTunnelName(): string {
        const data = this.deps.settings.get();
        return tunnelNameFor(data?.machineName, data?.machineId);
    }

    private now(): number {
        return this.deps.clock ? this.deps.clock.now() : Date.now();
    }
}
