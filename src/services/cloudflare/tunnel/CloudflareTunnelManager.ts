/**
 * CloudflareTunnelManager — "Cloudflare tự động": MỘT tunnel cho mỗi máy Boss, tên `deplao-<tên-máy>-<4 ký tự machineId>`,
 * tạo qua API với config_src 'cloudflare' (cấu hình nằm ở Cloudflare), MỘT tiến trình cloudflared phục vụ cả ba dịch vụ
 * (relay 9900, thanh toán 9888, webhook workflow 9889). Bật / tắt dịch vụ chỉ đổi ingress (PUT …/configurations),
 * không chạy lại tiến trình; tiến trình chạy khi có ≥ 1 dịch vụ bật. Ingress / DNS: ingress.ts, dns.ts.
 *
 * Phụ thuộc tiêm vào (test: src/__tests__/cloudflare/tunnelManager.test.ts):
 *   api      — CloudflareApi (ngân sách ~100 request / 5 phút cho CẢ app → không gọi thừa: nhớ ingress đã áp dụng,
 *              token giữ trong RAM, trạng thái phía Cloudflare đọc ≤ 10 phút/lần)
 *   settings — cloud-settings.json (phần tunnel: tunnelId, tunnelName, dnsRecordIds, enabled…)
 *   runner   — tiến trình cloudflared (index.ts: TunnelService, tự chạy lại theo backoff)
 *   clock    — thời gian cho giãn cách kiểm tra sức khoẻ
 *
 * Luồng API v4: GET cfd_tunnel?name=…&is_deleted=false → không có thì POST {name, config_src:'cloudflare'} →
 * GET …/{id}/token → GET + PUT …/{id}/configurations (giữ rule của tên miền khác) → DNS từng tên (dns.ts).
 * Tunnel đã bị xoá trên dashboard (404) → tạo lại, sửa DNS trỏ sang tunnel mới, làm lại một lần.
 *
 * Sức khoẻ: /ready của cloudflared trên máy (≤ 15 s/lần, nền khi tiến trình chạy) — 0 kết nối → địa chỉ 'restarting';
 * phía Cloudflare GET …/{id} (healthy/degraded/down/inactive) + …/{id}/connections + bản ghi DNS còn trỏ về máy này
 * không — ≤ 10 phút/lần, bấm kiểm tra (refresh) ≤ 30 s/lần.
 * Connector "lạ" = connector có id khác connector của máy này (id lấy từ dòng log "Generated Connector ID" / JSON
 * /ready của cloudflared). Chưa biết id của mình → coi một connector là của máy này (đếm thừa = số còn lại).
 *
 * Chế độ khác (Địa chỉ tạm / ngrok / Cloudflare thủ công): không gọi Cloudflare. Địa chỉ phản chiếu tunnel kiểu cũ của
 * từng cổng; bật / tắt dịch vụ = bật / tắt tunnel kiểu cũ đó qua cầu `legacy` (index.ts); "Tự bật khi mở app" =
 * relay_tunnel_autostart của relay.
 *
 * Mọi thao tác thay đổi chạy tuần tự (hàng đợi) — UI, relay tự bật và init() không giẫm lên nhau.
 */
import { CloudError, type CloudflareApi, type CloudSettingsData, type CloudSettingsStore, type CloudTunnelModule } from '../contracts';
import type {
    AddressLayout, PublicAddress, TunnelAutoConfig, TunnelConfigView, TunnelHealth, TunnelMode, TunnelServiceId,
} from '../../../shared/cloudContracts';
import {
    addressFor, buildIngress, distinctHostnames, hostnameFor, hostnamesFor, hostPrefixError, ingressKey, isTunnelService,
    legacyAddressFor, normalizeHostname, TUNNEL_SERVICES,
    type LegacyTunnelState, type ProcessState, type ServicePorts,
} from './ingress';
import { ensureRecords, inspectOwnership, removeRecords } from './dns';

/** /ready của cloudflared trên máy: tối đa một lần mỗi 15 s. */
export const LOCAL_READY_MIN_INTERVAL_MS = 15_000;
/** Trạng thái + connector phía Cloudflare: tối đa một lần mỗi 10 phút (ngân sách API). */
export const CF_STATUS_MIN_INTERVAL_MS = 10 * 60_000;
/** Bấm "Kiểm tra" (health({ refresh: true })): vẫn giãn tối thiểu 30 s. */
export const CF_STATUS_REFRESH_MIN_INTERVAL_MS = 30_000;
/** Đọc phía Cloudflare lỗi → thử lại sau 1 phút thay vì 10 phút. */
const CF_STATUS_RETRY_AFTER_ERROR_MS = 60_000;

type TunnelSettings = CloudSettingsData['tunnel'];

const TUNNEL_MODES: readonly TunnelMode[] = ['quick', 'ngrok', 'cloudflare_auto', 'cloudflare_manual'];
const NO_SERVICES: Record<TunnelServiceId, boolean> = { relay: false, payments: false, workflow: false };

// ─── Tiến trình cloudflared (runner) ─────────────────────────────────────────

export interface RunnerSnapshot {
    /** Tunnel mà tiến trình đang chạy cho (null nếu không rõ). */
    tunnelId: string | null;
    state: 'starting' | 'active' | 'restarting';
    lastError: string | null;
    restarts: number;
    attempt: number;
    nextRetryAt: number | null;
    /** Cổng metrics (127.0.0.1) — /ready, /metrics. */
    metricsPort: number | null;
    /** Connector ID của tiến trình này (đọc từ log cloudflared). */
    connectorId: string | null;
    version: string | null;
}

/** JSON /ready của cloudflared: {"status":200,"readyConnections":4,"connectorId":"…"} (503 khi 0 kết nối). */
export interface ReadyInfo {
    ready: boolean;
    readyConnections: number;
    connectorId: string | null;
}

export interface RunnerStartInput {
    tunnelId: string;
    token: string;
    /** Địa chỉ chính (relay) — chỉ để hiển thị / log; ingress nằm ở Cloudflare. */
    publicUrl: string;
}

export interface CloudTunnelRunner {
    /** Bật tiến trình; resolve khi có kết nối đầu tiên. Lỗi → reject nhưng vẫn tự thử lại nền (keepAlive). */
    start(input: RunnerStartInput): Promise<void>;
    /** Đổi sang tunnel khác không ngắt (make-before-break). */
    replace(input: RunnerStartInput): Promise<void>;
    stop(): Promise<void>;
    snapshot(): RunnerSnapshot | null;
    /** GET http://127.0.0.1:<metrics>/ready — null khi chưa biết cổng / không đọc được. */
    readiness(): Promise<ReadyInfo | null>;
    onChange(cb: () => void): () => void;
}

/** Cầu sang tunnel kiểu cũ (Quick / ngrok / Cloudflare thủ công) khi không ở chế độ tự động. */
export interface LegacyTunnelBridge {
    state(service: TunnelServiceId): LegacyTunnelState | null;
    /** Chế độ suy ra từ cấu hình relay cũ (relay_tunnel_provider), null nếu không đọc được. */
    mode?(): TunnelMode | null;
    /** Ghi chế độ cũ xuống cấu hình relay (để relay dùng đúng nhà cung cấp). */
    setMode?(mode: TunnelMode): void;
    /**
     * Bật / tắt tunnel kiểu cũ của một dịch vụ, đúng đường cũ (index.ts: relay → HttpRelayService.startTunnel /
     * stopTunnel, thanh toán → PaymentsTunnel, workflow → WebhookGatewayService). Lỗi → ném CloudError (câu cho người dùng).
     * Không được gọi ngược vào module tunnel (đang chạy trong hàng đợi của manager).
     */
    start?(service: TunnelServiceId): Promise<void>;
    stop?(service: TunnelServiceId): Promise<void>;
    /** "Tự bật khi mở app" của tunnel kiểu cũ (relay_tunnel_autostart), null nếu không đọc được. */
    autoStart?(): boolean | null;
    setAutoStart?(on: boolean): void;
}

export interface TunnelManagerDeps {
    api: () => CloudflareApi;
    settings: Pick<CloudSettingsStore, 'get' | 'update'>;
    runner: CloudTunnelRunner;
    clock?: { now(): number };
    /** Báo thay đổi (index.ts: cloudflare.notifyChanged('tunnel')). */
    notify?: () => void;
    /** Cổng thật của từng dịch vụ (mặc định 9900/9888/9889). */
    ports?: () => ServicePorts;
    legacy?: LegacyTunnelBridge;
    log?: { log(message: string): void; warn(message: string): void };
    /** Đọc /ready nền khi cloudflared chạy (ms); 0 / bỏ trống = tắt (test). */
    readyPollMs?: number;
}

interface ConnectorInfo {
    id: string;
    version: string | null;
    /** Số kết nối đang mở (không tính đang chờ nối lại). */
    conns: number;
    originIp: string | null;
}

interface CloudSnapshot {
    tunnelId: string;
    /** Lần đọc gần nhất. */
    at: number;
    /** Được đọc lại từ thời điểm này. */
    nextAt: number;
    status: string | null;
    connectors: ConnectorInfo[];
    error: string | null;
}

// ─── Hàm thuần ───────────────────────────────────────────────────────────────

function errorText(err: unknown): string {
    return (err as any)?.message || String(err);
}

function isNotFound(err: unknown): boolean {
    return (err as any)?.status === 404;
}

/** `deplao-<tên máy dạng slug>-<4 ký tự đầu machineId>`, vd deplao-may-ban-hang-ab12. */
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

/** Phần tunnel của cloud-settings.json, điền mặc định cho trường thiếu. */
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

/** Kiểm tra + chuẩn hoá cấu hình người dùng nhập. Lỗi → CloudError('INVALID_INPUT'). */
export function normalizeAutoInput(input: TunnelAutoConfig): TunnelAutoConfig {
    const zoneId = String(input?.zoneId ?? '').trim();
    const zoneName = normalizeHostname(input?.zoneName);
    const hostPrefix = normalizeHostname(input?.hostPrefix);
    const layout: AddressLayout = input?.layout === 'split' ? 'split' : 'single';
    if (!zoneId || !zoneName) throw new CloudError('INVALID_INPUT', 'Chọn tên miền (zone) trong tài khoản Cloudflare');
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
            // Không có danh sách conns → coi connector đang hoạt động
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
    /** Token tunnel chỉ giữ trong RAM (lấy lại mỗi lần mở app — 1 request). */
    private tokenCache: { tunnelId: string; token: string } | null = null;
    /** Ingress đã áp dụng trong phiên (tunnel + rule của Deplao) — trùng thì không GET/PUT lại. */
    private appliedIngress: string | null = null;
    /** Lỗi gần nhất khi cấp phát / bật tiến trình. */
    private lastError: string | null = null;
    /** Tên miền bị chặn (DNS trỏ sang máy khác / mất bản ghi) → thông báo. */
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
            // Cloudflare tự động: cloud-settings; chế độ khác: "Tự bật tunnel khi mở app" của relay (relay_tunnel_autostart)
            autoStart: mode === 'cloudflare_auto' ? t.autoStart : this.legacyAutoStart(t.autoStart),
            preview: t.auto ? hostnamesFor(t.auto) : { relay: '', payments: '', workflow: '' },
        };
    }

    async setMode(mode: TunnelMode): Promise<TunnelConfigView> {
        if (!TUNNEL_MODES.includes(mode)) throw new CloudError('INVALID_INPUT', 'Cách tạo địa chỉ không hợp lệ');
        return this.run(async () => {
            const previous = this.tunnel().mode;
            this.patchTunnel((t) => { t.mode = mode; });
            try {
                if (mode !== 'cloudflare_auto') {
                    // Quick / ngrok / thủ công: relay đọc relay_tunnel_provider như trước → ghi theo lựa chọn mới
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
            // Lần đầu cấu hình trên máy này: công tắc dịch vụ theo initialServices() (mặc định của cloud-settings là bật cả ba)
            const seeded = before.auto ? null : this.initialServices();
            try {
                const tunnelId = await this.ensureTunnel(false);
                const hosts = distinctHostnames(next);
                // Kiểm tra xung đột DNS cho MỌI tên trước khi ghi (DNS_CONFLICT → không đổi gì)
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
                // Quick / ngrok / thủ công: relay tự bật tunnel khi chạy nếu relay_tunnel_autostart = '1' (cấu hình cũ).
                // Thanh toán / webhook workflow không có tự bật ở các chế độ này (như trước).
                try {
                    legacy.setAutoStart(!!on);
                } catch (err) {
                    throw err instanceof CloudError ? err : new CloudError('SETTINGS_WRITE_FAILED', `Không lưu được "Tự bật khi mở app": ${errorText(err)}`);
                }
                return;
            }
            this.patchTunnel((t) => { t.autoStart = !!on; });
        });
        this.changed();
    }

    async setServiceEnabled(service: TunnelServiceId, enabled: boolean): Promise<PublicAddress[]> {
        if (!isTunnelService(service)) throw new CloudError('INVALID_INPUT', 'Dịch vụ không hợp lệ');
        const on = !!enabled;
        return this.run(async () => {
            const t = this.tunnel();
            const before = { ...t.enabled };
            if (t.mode !== 'cloudflare_auto') {
                // Chế độ khác: bật / tắt tunnel kiểu cũ của dịch vụ qua đúng đường cũ (cầu legacy ở index.ts: relay:startTunnel,
                // tunnel:start, workflow:startTunnel), không gọi Cloudflare. Công tắc chỉ ghi khi thành công; lần cấu hình tự
                // động đầu tiên đặt lại theo initialServices(). Cầu không có start/stop (bản cũ) → chỉ nhớ lựa chọn.
                const legacy = this.deps.legacy;
                try {
                    if (on) await legacy?.start?.(service);
                    else await legacy?.stop?.(service);
                    this.patchTunnel((s) => { s.enabled[service] = on; });
                } catch (err) {
                    this.log.warn(`[CloudTunnel] Không ${on ? 'bật' : 'tắt'} được tunnel kiểu cũ của ${service}: ${errorText(err)}`);
                    throw err instanceof CloudError
                        ? err
                        : new CloudError(on ? 'TUNNEL_START_FAILED' : 'TUNNEL_STOP_FAILED', `Không ${on ? 'bật' : 'tắt'} được địa chỉ: ${errorText(err)}`);
                } finally {
                    this.changed();
                }
                return this.addresses();
            }
            if (on && !t.auto) throw new CloudError('NOT_CONFIGURED', 'Chưa cấu hình địa chỉ Cloudflare tự động (chọn tên miền và tên)');
            this.patchTunnel((s) => { s.enabled[service] = on; });
            try {
                if (!t.auto) {
                    if (!this.anyEnabled()) await this.stopProcess();
                } else if (this.anyEnabled()) {
                    await this.provisionAndRun();
                } else {
                    // Tắt dịch vụ cuối: dừng tiến trình trước (ngừng phục vụ ngay); ingress cập nhật sau, lỗi API không chặn việc tắt
                    await this.stopProcess();
                    try {
                        await this.withTunnel((id, auto) => this.applyIngress(id, auto));
                    } catch (err) {
                        this.log.warn(`[CloudTunnel] Đã dừng cloudflared nhưng chưa cập nhật được ingress: ${errorText(err)}`);
                    }
                }
                this.lastError = null;
            } catch (err) {
                // Không áp dụng được → trả lại công tắc cũ để giao diện không báo sai
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
        // Tiến trình còn sống nhưng /ready báo 0 kết nối (mất mạng…) → cloudflared đang tự kết nối lại
        if (process === 'active' && this.local?.info && !this.local.info.ready) {
            process = 'restarting';
            error = 'cloudflared mất kết nối tới Cloudflare — đang tự kết nối lại';
        }
        const blocked = t.auto ? this.blocked.get(hostnameFor(t.auto, service)) ?? null : null;
        return addressFor(service, t.auto, { mode, enabled: !!t.enabled[service], process, error, blocked });
    }

    /** opts.refresh = người dùng bấm kiểm tra: đọc lại phía Cloudflare (vẫn giãn ≥ 30 s). */
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
            // Không biết connector nào của máy này thì không xoá (tránh tự ngắt chính mình)
            if (snap && !ourId) throw new CloudError('UNKNOWN_CONNECTOR', 'Chưa xác định được kết nối của máy này — thử lại sau vài giây');
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
                    // Thứ tự: dọn kết nối → xoá tunnel → xoá bản ghi DNS mang comment deplao:<id>
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
        // Không qua hàng đợi: thao tác đang chờ kết nối (≤ 30 s) không được giữ app lại lúc thoát
        try { await this.deps.runner.stop(); } catch { /* đã dừng */ }
    }

    // ─── Ngoài contract (relay / IPC dùng) ──────────────────────────────

    /** Nghe mọi thay đổi (bật/tắt, tiến trình lên/xuống, sức khoẻ đổi). Trả hàm huỷ. */
    subscribe(cb: () => void): () => void {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    }

    /** Chi tiết tiến trình cloudflared dùng chung (null khi không chạy). */
    processInfo(): RunnerSnapshot | null {
        return this.deps.runner.snapshot();
    }

    isAutoMode(): boolean {
        return this.tunnel().mode === 'cloudflare_auto';
    }

    // ─── Cấp phát ───────────────────────────────────────────────────────

    /** Tunnel của máy + DNS + ingress theo cấu hình đã lưu, rồi chạy / dừng cloudflared theo dịch vụ đang bật. */
    private async provisionAndRun(opts: { forceOwnTunnel?: boolean; checkDns?: boolean } = {}): Promise<void> {
        await this.withTunnel(async (tunnelId, auto) => {
            await this.applyIngress(tunnelId, auto);
            if (this.anyEnabled()) await this.ensureProcess(tunnelId, auto);
            else await this.stopProcess();
        }, opts);
    }

    /** Chạy fn với tunnel hợp lệ; tunnel đã bị xoá trên Cloudflare (404) → tạo lại, sửa DNS, chạy lại một lần. */
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
     * Tunnel của máy này: dùng tunnel đã lưu (đổi tên máy không tạo tunnel mới); forceOwn (moveHere) → bắt buộc
     * đúng tên của máy này. Tìm theo tên trước, không có mới tạo (config_src 'cloudflare').
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
                throw new CloudError('TUNNEL_CREATE_FAILED', 'Cloudflare không trả về tunnel vừa tạo');
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

    /** Bản ghi DNS cho mọi tên của layout (bỏ qua khi đã lưu đủ id, trừ khi force). */
    private async ensureDns(tunnelId: string, auto: TunnelAutoConfig, force: boolean): Promise<void> {
        const hosts = distinctHostnames(auto);
        const stored = this.tunnel().dnsRecordIds;
        if (!force && hosts.every((host) => stored[host])) return;
        const { recordIds, patched } = await ensureRecords(this.api(), auto.zoneId, hosts, tunnelId);
        if (patched.length) this.log.log(`[CloudTunnel] Đã trỏ ${patched.join(', ')} về tunnel của máy này`);
        this.patchTunnel((s) => { s.dnsRecordIds = { ...s.dnsRecordIds, ...recordIds }; });
        for (const host of hosts) this.blocked.delete(host);
    }

    /** Bản ghi DNS của tên cũ (đổi tiền tố / layout / zone) — lỗi chỉ ghi log. */
    private async cleanupHosts(zoneId: string, tunnelId: string, hosts: string[]): Promise<void> {
        try {
            const removed = await removeRecords(this.api(), zoneId, tunnelId, { hostnames: hosts, sweep: false });
            if (removed.length) this.log.log(`[CloudTunnel] Đã xoá bản ghi DNS cũ: ${removed.join(', ')}`);
        } catch (err) {
            this.log.warn(`[CloudTunnel] Chưa xoá được bản ghi DNS cũ (${hosts.join(', ')}): ${errorText(err)}`);
        }
    }

    /** GET cấu hình hiện tại rồi PUT (PUT thay CẢ cấu hình) — giữ rule của tên miền khác; giống hệt thì không PUT. */
    private async applyIngress(tunnelId: string, auto: TunnelAutoConfig, extraManaged: string[] = []): Promise<void> {
        const enabled = this.tunnel().enabled;
        const ports = this.ports();
        const managedHosts = Array.from(new Set([...Object.keys(this.tunnel().dnsRecordIds), ...extraManaged].map(normalizeHostname)));
        const ours = buildIngress(auto.layout, auto.hostPrefix, auto.zoneName, enabled, [], { ports, managedHosts });
        const key = `${tunnelId}|${ingressKey(ours)}|${managedHosts.sort().join(',')}`;
        if (this.appliedIngress === key) return; // đã áp dụng trong phiên này — không tốn request
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
        if (typeof token !== 'string' || !token.trim()) throw new CloudError('TUNNEL_TOKEN_MISSING', 'Cloudflare không trả token của tunnel');
        this.tokenCache = { tunnelId, token: token.trim() };
        return this.tokenCache.token;
    }

    /** cloudflared chạy cho đúng tunnel: chưa chạy → bật; đang chạy tunnel khác → đổi không ngắt; đúng rồi → thôi. */
    private async ensureProcess(tunnelId: string, auto: TunnelAutoConfig): Promise<void> {
        const snap = this.deps.runner.snapshot();
        if (snap && snap.tunnelId === tunnelId) return;
        const input: RunnerStartInput = { tunnelId, token: await this.fetchToken(tunnelId), publicUrl: `https://${hostnameFor(auto, 'relay')}` };
        try {
            if (snap) await this.deps.runner.replace(input);
            else await this.deps.runner.start(input);
            this.lastError = null;
        } catch (err) {
            // Tiến trình tự thử lại nền (keepAlive) — báo lỗi lên địa chỉ, không làm hỏng thao tác cấu hình
            this.lastError = errorText(err);
            this.log.warn(`[CloudTunnel] cloudflared chưa kết nối được: ${this.lastError} — đang tự thử lại`);
        }
    }

    private async stopProcess(): Promise<void> {
        this.local = null;
        await this.deps.runner.stop();
    }

    // ─── Sức khoẻ ───────────────────────────────────────────────────────

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
                        if (owner === 'elsewhere') blocked.set(host, `Tên ${host} đang trỏ sang máy khác — chọn "Chuyển địa chỉ về máy này" để dùng máy này`);
                        else if (owner === 'missing') blocked.set(host, `Bản ghi DNS của ${host} không còn — chọn "Chuyển địa chỉ về máy này" để tạo lại`);
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
            if (!snap) foreign = active.length; // máy này không chạy cloudflared → mọi connector là của máy khác
            else if (ourId) foreign = active.filter((c) => c.id !== ourId).length;
            else foreign = Math.max(0, active.length - 1); // chưa biết id của mình: coi một connector là của máy này
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

    /** Đọc /ready nền khi tiến trình chạy — 0 kết nối thì địa chỉ báo 'restarting' (không tốn ngân sách API). */
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

    // ─── Tiện ích ───────────────────────────────────────────────────────

    private run<T>(task: () => Promise<T>): Promise<T> {
        const result = this.queue.then(task, task);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }

    private changed(): void {
        try { this.deps.notify?.(); } catch { /* renderer chưa sẵn sàng */ }
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
            // Giữ trường lạ (cloud-settings giữ trường không biết khi chuẩn hoá)
            const current = draft.tunnel && typeof draft.tunnel === 'object' ? draft.tunnel : {};
            draft.tunnel = { ...current, ...t };
        });
    }

    /**
     * Công tắc dịch vụ cho lần cấu hình tự động đầu tiên: relay bật; thanh toán / webhook workflow chỉ bật khi tunnel
     * kiểu cũ của chúng đang bật (người dùng đã mở cổng đó ra Internet) — không tự mở thêm cổng nào.
     */
    private initialServices(): Record<TunnelServiceId, boolean> {
        const legacyOn = (service: TunnelServiceId): boolean => {
            try { return !!this.deps.legacy?.state(service); } catch { return false; }
        };
        return { relay: true, payments: legacyOn('payments'), workflow: legacyOn('workflow') };
    }

    /** "Tự bật khi mở app" của tunnel kiểu cũ; không đọc được (DB chưa mở, cầu bản cũ) → giá trị của cloud-settings. */
    private legacyAutoStart(fallback: boolean): boolean {
        try {
            const value = this.deps.legacy?.autoStart?.();
            if (typeof value === 'boolean') return value;
        } catch { /* DB chưa mở */ }
        return fallback;
    }

    /** 'cloudflare_auto' theo cài đặt; chế độ khác suy từ cấu hình relay cũ (đổi ở Cài đặt cũ vẫn khớp). */
    private effectiveMode(t: TunnelSettings): TunnelMode {
        if (t.mode === 'cloudflare_auto') return t.mode;
        try {
            const legacy = this.deps.legacy?.mode?.();
            if (legacy && legacy !== 'cloudflare_auto' && TUNNEL_MODES.includes(legacy)) return legacy;
        } catch { /* DB chưa mở */ }
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
        if (!auto) throw new CloudError('NOT_CONFIGURED', 'Chưa cấu hình địa chỉ Cloudflare tự động (chọn tên miền và tên)');
        return auto;
    }

    private accountId(): string {
        const id = this.deps.settings.get()?.accountId;
        if (!id) throw new CloudError('NOT_CONNECTED', 'Chưa kết nối tài khoản Cloudflare');
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
