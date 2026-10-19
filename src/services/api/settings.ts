/**
 * settings.ts — cài đặt của Public API & Plugin (lưu trong app_settings của workspace).
 *
 * Mọi giới hạn đều do khách tự đặt; mặc định KHÔNG rate limit.
 */

export interface SettingsStore {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

export const API_SETTING_DEFAULTS = {
    /** '0' = /api/v1 trả 503 ngay, không ghi log/event, không hook. Công tắc khẩn cấp. */
    api_enabled: '1',
    /** Tự bật API server (relay port) khi mở app. */
    api_server_autostart: '0',
    /** '1' = trang /docs và openapi.json ai cũng xem được, kể cả từ xa không cần key (mặc định). '0' = từ xa phải có key. */
    api_docs_public: '1',
    /** Giới hạn mặc định request/phút cho mỗi API key. 0 = không giới hạn. */
    api_default_rate_limit: '0',
    /** Giới hạn request/phút cho mỗi plugin. 0 = không giới hạn. */
    plugins_rate_limit_per_min: '0',
    /** Số lời gọi IPC chạy đồng thời từ API/plugin (còn lại xếp hàng). 0 = không giới hạn. */
    api_ipc_concurrency: '4',
    /** Thời gian tối đa một lời gọi IPC (ms). */
    api_ipc_timeout_ms: '30000',
    /** Tạm chặn IP gửi quá nhiều key sai (key hợp lệ không bị ảnh hưởng). */
    api_auth_bruteforce_guard: '1',
    /** Lấy IP thật từ X-Forwarded-For / CF-Connecting-IP khi request đi qua tunnel chạy trên máy. */
    api_trust_proxy_headers: '1',
    /** Relay chỉ lắng nghe 127.0.0.1 (máy không có nhân viên LAN). */
    api_bind_localhost_only: '0',
    /** Số ngày giữ nhật ký request. */
    api_request_log_days: '7',
    /** Số event tối đa lưu để catch-up. */
    api_events_max: '50000',
    /** Số ngày giữ event. */
    api_events_days: '7',
    /** '1' = cho phép tải URL / gửi webhook tới mạng nội bộ (10.x, 192.168.x, 127.x) cả với request từ xa.
     *  Mặc định chỉ request gọi từ chính máy (không qua tunnel) mới được trỏ vào mạng nội bộ. */
    api_allow_private_urls: '0',
    /** Giới hạn body JSON (MB). */
    api_max_body_mb: '10',
    /** Giới hạn file upload (MB). */
    api_upload_max_mb: '100',
    /** Tối đa số plugin bật cùng lúc. */
    plugins_max_enabled: '10',
} as const;

export type ApiSettingKey = keyof typeof API_SETTING_DEFAULTS;

export const API_SETTING_KEYS = Object.keys(API_SETTING_DEFAULTS) as ApiSettingKey[];

let store: SettingsStore | null = null;

/** Mặc định đọc DatabaseService; test có thể thay bằng store giả. */
export function setSettingsStore(next: SettingsStore | null): void {
    store = next;
    cache.clear();
}

function getStore(): SettingsStore {
    if (store) return store;
    // Lazy require: giữ module import được trong test không có Electron.
    const DatabaseService = require('../database/DatabaseService').default;
    return {
        get: (key: string) => DatabaseService.getInstance().getSetting(key),
        set: (key: string, value: string) => DatabaseService.getInstance().setSetting(key, value),
    };
}

/** Cache 2 giây: settings được đọc ở mọi request, không cần query DB mỗi lần. */
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
