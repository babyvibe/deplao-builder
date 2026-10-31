/**
 * ip.ts — chuẩn hoá IP và so khớp allowlist (IP đơn hoặc CIDR IPv4).
 */
import * as net from 'net';
import type { IncomingMessage } from 'http';

export function normalizeIp(ip: string | undefined | null): string {
    if (!ip) return '';
    let v = String(ip).trim();
    if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7);
    if (v === '::1') return '127.0.0.1';
    return v;
}

export function isLoopback(ip: string): boolean {
    const v = normalizeIp(ip);
    return v === '127.0.0.1' || v.startsWith('127.') || v === 'localhost';
}

function ipv4ToInt(ip: string): number | null {
    if (!net.isIPv4(ip)) return null;
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** Hợp lệ: "1.2.3.4", "10.0.0.0/8", "2001:db8::1". */
export function isValidIpRule(rule: string): boolean {
    const v = String(rule || '').trim();
    if (!v) return false;
    if (v.includes('/')) {
        const [base, bits] = v.split('/');
        const n = Number(bits);
        return net.isIPv4(base) && Number.isInteger(n) && n >= 0 && n <= 32;
    }
    return net.isIP(v) !== 0;
}

export function ipMatches(ip: string, rule: string): boolean {
    const target = normalizeIp(ip);
    const r = String(rule || '').trim();
    if (!target || !r) return false;
    if (!r.includes('/')) return normalizeIp(r) === target;
    const [base, bitsRaw] = r.split('/');
    const bits = Number(bitsRaw);
    const a = ipv4ToInt(target);
    const b = ipv4ToInt(base);
    if (a === null || b === null || !Number.isInteger(bits)) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function ipAllowed(ip: string, rules: string[] | null | undefined): boolean {
    if (!rules || rules.length === 0) return true;
    return rules.some(rule => ipMatches(ip, rule));
}

/**
 * IP của client. Khi request đến từ loopback (tunnel agent chạy trên máy) và cho phép
 * tin proxy header, lấy IP thật từ CF-Connecting-IP / X-Forwarded-For.
 */
export function clientIp(req: IncomingMessage, trustProxyHeaders: boolean): { ip: string; viaProxy: boolean } {
    const socketIp = normalizeIp(req.socket?.remoteAddress || '');
    if (trustProxyHeaders && isLoopback(socketIp)) {
        const cf = req.headers['cf-connecting-ip'];
        if (typeof cf === 'string' && cf.trim()) return { ip: normalizeIp(cf), viaProxy: true };
        const xff = req.headers['x-forwarded-for'];
        const first = (Array.isArray(xff) ? xff[0] : xff || '').split(',')[0].trim();
        if (first) return { ip: normalizeIp(first), viaProxy: true };
    }
    return { ip: socketIp, viaProxy: false };
}

/** Request được coi là "local" khi đến từ loopback và không mang header của tunnel. */
export function isLocalRequest(req: IncomingMessage): boolean {
    const socketIp = normalizeIp(req.socket?.remoteAddress || '');
    if (!isLoopback(socketIp)) return false;
    return !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers['ngrok-trace-id'];
}
