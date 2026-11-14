/**
 * settings.ts: settings of the Public API & Plugin (stored in the workspace's app_settings).
 *
 * Every limit is set by the customer; by default there is NO rate limit.
 */

export interface SettingsStore {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

export const API_SETTING_DEFAULTS = {
    /** '0' = /api/v1 returns 503 right away, no logs/events, no hooks. Emergency switch. */
    api_enabled: '1',
    /** Automatically start the API server (relay port) when the app opens. */
    api_server_autostart: '0',
    /** '1' = anyone can view the /docs page and openapi.json, including remotely without a key (default). '0' = remote access requires a key. */
    api_docs_public: '1',
    /** Default request/minute limit per API key. 0 = no limit. */
    api_default_rate_limit: '0',
    /** Request/minute limit per plugin. 0 = no limit. */
    plugins_rate_limit_per_min: '0',
    /** Number of IPC calls from the API/plugins that run at the same time (the rest queue up). 0 = no limit. */
    api_ipc_concurrency: '4',
    /** Maximum time for one IPC call (ms). */
    api_ipc_timeout_ms: '30000',
    /** Temporarily block IPs that send too many wrong keys (valid keys are not affected). */
    api_auth_bruteforce_guard: '1',
    /** Take the real IP from X-Forwarded-For / CF-Connecting-IP when the request goes through a tunnel running on the machine. */
    api_trust_proxy_headers: '1',
    /** Relay only listens on 127.0.0.1 (machines with no LAN employees). */
    api_bind_localhost_only: '0',
    /** Number of days to keep the request log. */
    api_request_log_days: '7',
    /** Maximum number of events stored for catch-up. */
    api_events_max: '50000',
    /** Number of days to keep events. */
    api_events_days: '7',
    /** '1' = allow downloading URLs / sending webhooks to the private network (10.x, 192.168.x, 127.x), including for remote requests.
     *  By default only requests made from the machine itself (not through the tunnel) may point to the private network. */
    api_allow_private_urls: '0',
    /** JSON body limit (MB). */
    api_max_body_mb: '10',
    /** File upload limit (MB). */
    api_upload_max_mb: '100',
    /** Maximum number of plugins enabled at the same time. */
    plugins_max_enabled: '10',
} as const;

export type ApiSettingKey = keyof typeof API_SETTING_DEFAULTS;

export const API_SETTING_KEYS = Object.keys(API_SETTING_DEFAULTS) as ApiSettingKey[];

let store: SettingsStore | null = null;

/** Reads from DatabaseService by default; tests can replace it with a fake store. */
export function setSettingsStore(next: SettingsStore | null): void {
    store = next;
    cache.clear();
}

function getStore(): SettingsStore {
    if (store) return store;
    // Lazy require: keeps the module importable in tests without Electron.
    const DatabaseService = require('../database/DatabaseService').default;
    return {
        get: (key: string) => DatabaseService.getInstance().getSetting(key),
        set: (key: string, value: string) => DatabaseService.getInstance().setSetting(key, value),
    };
}

/** 2-second cache: settings are read on every request, so there is no DB query each time. */
const cache = new Map<string, { value: string; at: number }>();
const CACHE_MS = 2000;

export function getApiSetting(key: ApiSettingKey): string {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    let value: string | null = null;
    try { value = getStore().get(key); } catch { value = null; }
    const resolved = value === null || value === undefined ? API_SETTING_DEFAULTS[key] : String(value);
    cache.set(key, { value: resolved, at: now });
    return resolved;
}

export function getApiSettingNumber(key: ApiSettingKey): number {
    const n = Number(getApiSetting(key));
    return Number.isFinite(n) ? n : Number(API_SETTING_DEFAULTS[key]) || 0;
}

export function getApiSettingBool(key: ApiSettingKey): boolean {
    return getApiSetting(key) === '1';
}

export function setApiSetting(key: ApiSettingKey, value: string): void {
    getStore().set(key, String(value));
    cache.delete(key);
}

export function getAllApiSettings(): Record<ApiSettingKey, string> {
    const out = {} as Record<ApiSettingKey, string>;
    for (const key of API_SETTING_KEYS) out[key] = getApiSetting(key);
    return out;
}

export function clearApiSettingsCache(): void {
    cache.clear();
}
