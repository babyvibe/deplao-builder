/**
 * Ingress + public address of "Cloudflare tự động" (automatic Cloudflare): the PURE part (no API calls, no Electron).
 * Test: src/__tests__/cloudflare/tunnelIngress.test.ts.
 *
 * Layout 'single' (default): one name `<prefix>.<zone>` for every service, split by path (SINGLE_HOST_PATH_RULES;
 * cloudflared passes the path through unchanged to the origin server):
 *   ^/webhook/               → http://127.0.0.1:9888  (payments / integrations)
 *   ^/api/workflow/webhook/  → http://127.0.0.1:9889  (workflow webhook)
 *   everything else          → http://127.0.0.1:9900  (relay: employees, API v1, Socket.IO, SSE)
 * Layout 'split': `<prefix>` / `<prefix>-pay` / `<prefix>-hook`: ONE-level names (free Universal SSL only covers one level).
 * Uses 127.0.0.1 (servers 9888/9889 only listen on 127.0.0.1).
 *
 * A service that is turned off → its rule is dropped (the ingress changes, cloudflared is not restarted). A layout name that no rule catches any more
 * (e.g. 'single' with the relay off but payments on) → a separate 404 is added for that name, so the paths of services that are off always return 404,
 * even when the user has a wildcard rule. Rules of OTHER domains (the user added them in the dashboard) are kept, placed AFTER Deplao's rules
 * (their wildcard does not swallow Deplao's names). The last rule is always { service: 'http_status:404' }.
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
import { tr } from '../../../shared/i18n';

export const TUNNEL_SERVICES: readonly TunnelServiceId[] = ['relay', 'payments', 'workflow'];

/** The last ingress rule (Cloudflare requires the last rule to have no hostname). */
export const CATCH_ALL_404 = 'http_status:404';

/** The prefix + the longest suffix ('-hook') must fit in one DNS label (≤ 63 characters). */
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

/** Error message (Vietnamese) for the name prefix, or null if valid. Only a-z, 0-9, '-' (not at the start / end). */
export function hostPrefixError(prefix: string): string | null {
    const value = String(prefix ?? '');
    if (!value) return tr('Nhập tên cho địa chỉ, vd "shop" → shop.tenmien.vn');
    if (value.length > HOST_PREFIX_MAX) return tr('Tên tối đa {{HOST_PREFIX_MAX}} ký tự', { HOST_PREFIX_MAX });
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
        return tr('Tên chỉ gồm chữ thường a-z, số 0-9 và dấu "-" (không đặt "-" ở đầu hoặc cuối)');
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

/** Host name of a service per the config ('single': all three share one name). */
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

/** The names that need DNS records per layout ('single': 1, 'split': 3). */
export function distinctHostnames(config: HostConfig): string[] {
    return Array.from(new Set(TUNNEL_SERVICES.map((service) => hostnameFor(config, service))));
}

/** Every Deplao name that can be used with this prefix (both layouts): their rules are always managed by Deplao. */
export function managedHostnames(prefix: string, zoneName: string): string[] {
    const p = normalizeHostname(prefix);
    const zone = normalizeHostname(zoneName);
    if (!p || !zone) return [];
    return Array.from(new Set(TUNNEL_SERVICES.map((service) => splitHostname(p, service, zone))));
}

/** Rules the user added (domains not managed by Deplao): kept as they are when PUT replaces the whole config. */
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
            continue; // old catch-all rule: replaced by the final 404
        }
        kept.push({ ...rule });
    }
    return kept;
}

/**
 * The full ingress for PUT …/configurations (PUT replaces the WHOLE config): Deplao's rules per the layout + the services that are on,
 * then the other domains' rules taken from the current config, and finally the 404.
 * opts.managedHosts: Deplao names used before (prefix / domain changed): their old rules are dropped.
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
    // SINGLE_HOST_PATH_RULES order: a rule with a path comes before the catch-all rule of the same name.
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

/** JSON with sorted keys (empty / missing object → ''), so the comparison does not depend on key order. */
function stableJson(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (!keys.length) return '';
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** Comparison key for ingress (ignores harmless differences: host name case, an empty originRequest that Cloudflare adds by itself). */
export function ingressKey(rules: unknown): string {
    if (!Array.isArray(rules)) return '[]';
    return JSON.stringify(rules.map((rule: any) => [
        normalizeHostname(rule?.hostname),
        String(rule?.path ?? ''),
        String(rule?.service ?? '').trim(),
        stableJson(rule?.originRequest),
    ]));
}

// ─── Public address ───────────────────────────────────────────────────────

export type ProcessState = 'active' | 'starting' | 'restarting' | 'stopped';

export interface AutoAddressState {
    mode: TunnelMode;
    enabled: boolean;
    /** The shared cloudflared process. */
    process: ProcessState;
    error?: string | null;
    /** A blocking error for the service's own name (e.g. a DNS record pointing at another machine) → state 'error' even though the process is running. */
    blocked?: string | null;
}

/**
 * PublicAddress of "Cloudflare tự động" (automatic Cloudflare). url = the BASE address (https://host, no path); the existing code still appends
 * `/api/v1`, `/webhook/<kind>`, `/api/workflow/webhook/<token>` itself, as it does with tunnelUrl today. A service that is off → url null.
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

/** State of the old-style tunnel of the service port (TunnelService.getState). */
export interface LegacyTunnelState {
    url: string | null;
    state: 'starting' | 'active' | 'restarting';
    kind: 'fixed' | 'temporary';
    lastError?: string | null;
}

/** PublicAddress when NOT in automatic mode: mirrors the port's old tunnel (Quick / ngrok / manual Cloudflare). */
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
