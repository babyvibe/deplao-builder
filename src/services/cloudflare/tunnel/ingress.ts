/**
 * Ingress + địa chỉ công khai của "Cloudflare tự động" — phần THUẦN (không gọi API, không Electron).
 * Test: src/__tests__/cloudflare/tunnelIngress.test.ts.
 *
 * Layout 'single' (mặc định): một tên `<prefix>.<zone>` cho mọi dịch vụ, chia theo đường dẫn (SINGLE_HOST_PATH_RULES,
 * cloudflared chuyển nguyên đường dẫn tới server gốc):
 *   ^/webhook/               → http://127.0.0.1:9888  (thanh toán / tích hợp)
 *   ^/api/workflow/webhook/  → http://127.0.0.1:9889  (webhook workflow)
 *   còn lại                  → http://127.0.0.1:9900  (relay: nhân viên, API v1, Socket.IO, SSE)
 * Layout 'split': `<prefix>` / `<prefix>-pay` / `<prefix>-hook` — tên MỘT cấp (Universal SSL miễn phí chỉ phủ một cấp).
 * Dùng 127.0.0.1 (server 9888/9889 chỉ nghe 127.0.0.1).
 *
 * Dịch vụ tắt → bỏ rule của nó (đổi ingress, không chạy lại cloudflared). Tên miền của layout mà không còn rule bắt hết
 * (vd 'single' tắt relay nhưng bật thanh toán) → thêm 404 riêng cho tên đó, nên đường dẫn không bật luôn trả 404 kể cả
 * khi người dùng có rule wildcard. Rule của tên miền KHÁC (người dùng tự thêm trên dashboard) giữ nguyên, đặt SAU rule
 * của Deplao (wildcard của họ không nuốt tên của Deplao). Rule cuối luôn { service: 'http_status:404' }.
 */
import {
    SINGLE_HOST_PATH_RULES,
    splitHostname,
    type AddressLayout,
    type PublicAddress,
    type TunnelAutoConfig,
    type TunnelMode,
    type TunnelServiceId,
} from '../../../shared/cloud/cloudContracts';

export const TUNNEL_SERVICES: readonly TunnelServiceId[] = ['relay', 'payments', 'workflow'];

/** Rule cuối của ingress (Cloudflare bắt buộc rule cuối không có hostname). */
export const CATCH_ALL_404 = 'http_status:404';

/** Tiền tố + hậu tố dài nhất ('-hook') phải vừa một nhãn DNS (≤ 63 ký tự). */
export const HOST_PREFIX_MAX = 58;

export interface IngressRule {
    hostname?: string;
    path?: string;
    service: string;
    originRequest?: Record<string, unknown>;
    [key: string]: unknown;
}

export type ServicePorts = Partial<Record<TunnelServiceId, number>>;
export type ServiceFlags = Partial<Record<TunnelServiceId, boolean>>;

type HostConfig = Pick<TunnelAutoConfig, 'hostPrefix' | 'zoneName' | 'layout'>;

export function normalizeHostname(raw: unknown): string {
    return String(raw ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

export function isTunnelService(value: unknown): value is TunnelServiceId {
    return value === 'relay' || value === 'payments' || value === 'workflow';
}

/** Lỗi (tiếng Việt) của tiền tố tên, hoặc null khi hợp lệ. Chỉ a-z, 0-9, '-' (không ở đầu/cuối). */
export function hostPrefixError(prefix: string): string | null {
    const value = String(prefix ?? '');
    if (!value) return 'Nhập tên cho địa chỉ, vd "shop" → shop.tenmien.vn';
    if (value.length > HOST_PREFIX_MAX) return `Tên tối đa ${HOST_PREFIX_MAX} ký tự`;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
        return 'Tên chỉ gồm chữ thường a-z, số 0-9 và dấu "-" (không đặt "-" ở đầu hoặc cuối)';
    }
    return null;
}

export function defaultServicePort(service: TunnelServiceId): number {
    return SINGLE_HOST_PATH_RULES.find((rule) => rule.service === service)?.port ?? 9900;
}

function portOf(service: TunnelServiceId, ports?: ServicePorts): number {
    const port = Number(ports?.[service]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : defaultServicePort(service);
}

export function originFor(service: TunnelServiceId, ports?: ServicePorts): string {
    return `http://127.0.0.1:${portOf(service, ports)}`;
}

/** Tên host của một dịch vụ theo cấu hình ('single': cả ba chung một tên). */
export function hostnameFor(config: HostConfig, service: TunnelServiceId): string {
    const prefix = normalizeHostname(config.hostPrefix);
    const zone = normalizeHostname(config.zoneName);
    if (config.layout === 'split') return splitHostname(prefix, service, zone);
    return `${prefix}.${zone}`;
}

export function hostnamesFor(config: HostConfig): Record<TunnelServiceId, string> {
    return {
        relay: hostnameFor(config, 'relay'),
        payments: hostnameFor(config, 'payments'),
        workflow: hostnameFor(config, 'workflow'),
    };
}

/** Các tên cần bản ghi DNS theo layout ('single': 1, 'split': 3). */
export function distinctHostnames(config: HostConfig): string[] {
    return Array.from(new Set(TUNNEL_SERVICES.map((service) => hostnameFor(config, service))));
}

/** Mọi tên Deplao có thể dùng với tiền tố này (cả hai layout) — rule của chúng luôn do Deplao quản lý. */
export function managedHostnames(prefix: string, zoneName: string): string[] {
    const p = normalizeHostname(prefix);
    const zone = normalizeHostname(zoneName);
    if (!p || !zone) return [];
    return Array.from(new Set(TUNNEL_SERVICES.map((service) => splitHostname(p, service, zone))));
}

/** Rule người dùng tự thêm (tên miền không do Deplao quản lý) — giữ nguyên khi PUT thay cả cấu hình. */
export function foreignRules(existingRules: unknown, managed: Iterable<string>): IngressRule[] {
    if (!Array.isArray(existingRules)) return [];
    const managedSet = new Set(Array.from(managed, normalizeHostname));
    const kept: IngressRule[] = [];
    for (const raw of existingRules) {
        if (!raw || typeof raw !== 'object') continue;
        const rule = raw as IngressRule;
        if (typeof rule.service !== 'string' || !rule.service.trim()) continue;
        const host = normalizeHostname(rule.hostname);
        if (host) {
            if (managedSet.has(host)) continue;
        } else if (!(typeof rule.path === 'string' && rule.path.trim())) {
            continue; // rule bắt hết cũ — thay bằng 404 cuối
        }
        kept.push({ ...rule });
    }
    return kept;
}

/**
 * Ingress đầy đủ để PUT …/configurations (PUT thay CẢ cấu hình): rule của Deplao theo layout + dịch vụ đang bật,
 * rồi rule của tên miền khác lấy từ cấu hình hiện tại, cuối cùng là 404.
 * opts.managedHosts: tên Deplao đã dùng trước đó (đổi tiền tố / tên miền) — rule cũ của chúng bị bỏ.
 */
export function buildIngress(
    layout: AddressLayout,
    prefix: string,
    zone: string,
    enabled: ServiceFlags,
    existingRules: unknown,
    opts: { ports?: ServicePorts; managedHosts?: Iterable<string> } = {},
): IngressRule[] {
    const config: HostConfig = { layout: layout === 'split' ? 'split' : 'single', hostPrefix: prefix, zoneName: zone };
    const ours: IngressRule[] = [];
    const covered = new Set<string>();
    // Thứ tự SINGLE_HOST_PATH_RULES: rule có đường dẫn đứng trước rule bắt hết của cùng tên.
    for (const rule of SINGLE_HOST_PATH_RULES) {
        if (!enabled?.[rule.service]) continue;
        const hostname = hostnameFor(config, rule.service);
        const service = originFor(rule.service, opts.ports);
        if (config.layout === 'single' && rule.path) {
            ours.push({ hostname, path: rule.path, service });
        } else {
            ours.push({ hostname, service });
            covered.add(hostname);
        }
    }
    for (const hostname of distinctHostnames(config)) {
        if (!covered.has(hostname)) ours.push({ hostname, service: CATCH_ALL_404 });
    }
    const managed = [...managedHostnames(prefix, zone), ...Array.from(opts.managedHosts ?? [], normalizeHostname)];
    return [...ours, ...foreignRules(existingRules, managed), { service: CATCH_ALL_404 }];
}

/** JSON với khoá sắp xếp (đối tượng rỗng / thiếu → ''), để so sánh không phụ thuộc thứ tự khoá. */
function stableJson(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (!keys.length) return '';
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** Khoá so sánh ingress (bỏ qua khác biệt vô hại: hoa/thường tên host, originRequest rỗng Cloudflare tự thêm). */
export function ingressKey(rules: unknown): string {
    if (!Array.isArray(rules)) return '[]';
    return JSON.stringify(rules.map((rule: any) => [
        normalizeHostname(rule?.hostname),
        String(rule?.path ?? ''),
        String(rule?.service ?? '').trim(),
        stableJson(rule?.originRequest),
    ]));
}

// ─── Địa chỉ công khai ───────────────────────────────────────────────────────

export type ProcessState = 'active' | 'starting' | 'restarting' | 'stopped';

export interface AutoAddressState {
    mode: TunnelMode;
    enabled: boolean;
    /** Tiến trình cloudflared dùng chung. */
    process: ProcessState;
    error?: string | null;
    /** Lỗi chặn riêng tên của dịch vụ (vd bản ghi DNS đang trỏ sang máy khác) → state 'error' dù tiến trình chạy. */
    blocked?: string | null;
}

/**
 * PublicAddress của "Cloudflare tự động". url = địa chỉ GỐC (https://host, không đường dẫn) — code hiện có tự nối
 * `/api/v1`, `/webhook/<loại>`, `/api/workflow/webhook/<token>` như với tunnelUrl hôm nay. Dịch vụ tắt → url null.
 */
export function addressFor(service: TunnelServiceId, config: TunnelAutoConfig | null, state: AutoAddressState): PublicAddress {
    const configured = !!config && !!normalizeHostname(config.hostPrefix) && !!normalizeHostname(config.zoneName);
    const enabled = !!state.enabled;
    const url = configured && enabled ? `https://${hostnameFor(config as TunnelAutoConfig, service)}` : null;
    let error = enabled ? state.error ?? null : null;
    let addressState: PublicAddress['state'];
    if (!url) {
        addressState = enabled && error ? 'error' : 'stopped';
    } else if (state.blocked) {
        addressState = 'error';
        error = state.blocked;
    } else if (state.process === 'stopped') {
        addressState = error ? 'error' : 'stopped';
    } else {
        addressState = state.process;
        if (addressState === 'active') error = null;
    }
    return { service, url, kind: url ? 'fixed' : null, state: addressState, enabled, mode: state.mode, error };
}

/** Trạng thái tunnel kiểu cũ của cổng dịch vụ (TunnelService.getState). */
export interface LegacyTunnelState {
    url: string | null;
    state: 'starting' | 'active' | 'restarting';
    kind: 'fixed' | 'temporary';
    lastError?: string | null;
}

/** PublicAddress khi KHÔNG ở chế độ tự động: phản chiếu tunnel cũ (Quick / ngrok / Cloudflare thủ công) của cổng. */
export function legacyAddressFor(service: TunnelServiceId, mode: TunnelMode, legacy: LegacyTunnelState | null): PublicAddress {
    if (!legacy) return { service, url: null, kind: null, state: 'stopped', enabled: false, mode, error: null };
    return {
        service,
        url: legacy.url ?? null,
        kind: legacy.kind,
        state: legacy.state,
        enabled: true,
        mode,
        error: legacy.state === 'active' ? null : legacy.lastError ?? null,
    };
}
