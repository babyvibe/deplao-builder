import Logger from '../Logger';
import type { ProxyConfig } from '../../models';

/**
 * Build a proxy URL from the proxy config.
 * Format: protocol://user:pass@host:port
 */
export function buildProxyUrl(proxy: ProxyConfig): string {
    const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
        : '';
    return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * Create a proxy agent compatible with zca-js (the agent option in the Zalo constructor).
 * Uses proxy-agent to detect HTTP/HTTPS/SOCKS4/SOCKS5 automatically.
 * Returns undefined if the proxy is null/undefined or if creation fails.
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
