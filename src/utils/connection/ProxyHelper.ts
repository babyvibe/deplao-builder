import Logger from '../Logger';
import type { ProxyConfig } from '../../models';

/**
 * Tạo proxy URL từ cấu hình proxy.
 * Format: protocol://user:pass@host:port
 */
export function buildProxyUrl(proxy: ProxyConfig): string {
    const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
        : '';
    return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * Tạo proxy agent tương thích với zca-js (agent option trong Zalo constructor).
 * Dùng proxy-agent để tự động nhận diện HTTP/HTTPS/SOCKS4/SOCKS5.
 * Trả về undefined nếu proxy là null/undefined hoặc nếu tạo thất bại.
 */
export function createProxyAgent(proxy: ProxyConfig | null | undefined): any {
    if (!proxy) return undefined;

    const proxyUrl = buildProxyUrl(proxy);

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ProxyAgent } = require('proxy-agent');
        Logger.log(`[ProxyHelper] Creating proxy agent for ${proxy.host}:${proxy.port} (${proxy.name}) type=${proxy.type}`);
        // getProxyForUrl callback - proxy-agent auto-detects HTTP/HTTPS/SOCKS from URL protocol
        return new ProxyAgent({
            getProxyForUrl: () => proxyUrl
        });
    } catch (err: any) {
        Logger.error(`[ProxyHelper] Failed to create proxy agent for "${proxy.name}": ${err.message}`);
        return undefined;
    }
}
