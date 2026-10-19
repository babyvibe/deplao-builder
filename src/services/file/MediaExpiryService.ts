/**
 * Nhận diện media Zalo đã hết hạn (Zalo không còn lưu file):
 *   - CDN trả 404 / 410 (host CDN còn sống nhưng file đã bị xoá — vd `f20-zpc.zdn.vn` trả 404), hoặc
 *   - host CDN cũ đã bị gỡ khỏi DNS (vd `f21-zpc` / `f24-zpc.zdn.vn` → ENOTFOUND) trong khi `chat.zalo.me`
 *     vẫn phân giải được — tức không phải do máy đang mất mạng.
 * 401/403 KHÔNG tính là hết hạn (thường do cookie phiên cũ). Lỗi khác (timeout, mất mạng, 5xx) → 'unknown'.
 */
import * as dns from 'dns';
import axios from 'axios';
import FileStorageService from './FileStorageService';

export type MediaAvailability = 'ok' | 'expired' | 'unknown';

const ZALO_MEDIA_HOST_RE = /(^|\.)(zdn\.vn|zadn\.vn|zalo\.me|zaloapp\.com)$/i;
const EXPIRED_STATUS = new Set([404, 410]);
const DNS_HEALTH_TTL_MS = 30 * 1000;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

let dnsHealth: { at: number; ok: boolean } | null = null;

function hostOf(url: string): string {
    try { return new URL(url).hostname; } catch { return ''; }
}

export function isZaloMediaHost(url: string): boolean {
    return ZALO_MEDIA_HOST_RE.test(hostOf(url));
}

async function zaloDnsHealthy(): Promise<boolean> {
    if (dnsHealth && Date.now() - dnsHealth.at < DNS_HEALTH_TTL_MS) return dnsHealth.ok;
    let ok = false;
    try {
        await dns.promises.lookup('chat.zalo.me');
        ok = true;
    } catch { /* mất mạng / DNS hỏng */ }
    dnsHealth = { at: Date.now(), ok };
    return ok;
}

/** Phân loại lỗi khi tải media (lỗi axios hoặc lỗi mạng của Node). */
export async function classifyMediaError(url: string, err: any): Promise<MediaAvailability> {
    const status = Number(err?.response?.status || 0);
    if (EXPIRED_STATUS.has(status)) return 'expired';
    const code = String(err?.code || err?.cause?.code || '');
    if (code === 'ENOTFOUND' && isZaloMediaHost(url) && await zaloDnsHealthy()) return 'expired';
    return 'unknown';
}

/** Kiểm tra nhanh 1 URL media (GET 1 byte) bằng cookie + User-Agent của tài khoản. */
export async function probeMediaUrl(url: string, cookiesJson?: string, userAgent?: string): Promise<MediaAvailability> {
    if (!/^https?:\/\//i.test(url)) return 'unknown';
    const headers: Record<string, string> = {
        'User-Agent': userAgent || DEFAULT_UA,
        Referer: 'https://chat.zalo.me/',
        Range: 'bytes=0-0',
    };
    const cookie = cookiesJson ? FileStorageService.buildCookieHeader(cookiesJson) : '';
    if (cookie && isZaloMediaHost(url)) headers.Cookie = cookie;
    try {
        const res = await axios.get(url, {
            headers,
            responseType: 'stream',
            timeout: 10000,
            maxRedirects: 3,
            validateStatus: () => true,
        });
        res.data?.destroy?.();
        if (res.status >= 200 && res.status < 400) return 'ok';
        return EXPIRED_STATUS.has(res.status) ? 'expired' : 'unknown';
    } catch (err) {
        return classifyMediaError(url, err);
    }
}
