/**
 * PluginProtocol — phục vụ UI plugin qua deplao-plugin://<id>/<path> (mỗi plugin một origin riêng,
 * khác origin của app → iframe plugin không chạm được DOM/IPC của app).
 *
 *  - Chỉ plugin đang bật; file nằm trong thư mục plugin (kiểm tra realpath, chặn symlink ra ngoài).
 *  - CSP chặt: script/style chỉ từ chính plugin; không fetch ra ngoài trừ ui.connectSrc (cần quyền network).
 *  - /__deplao/sdk.js trả SDK web nhúng sẵn trong app.
 *  - Trang bị nhúng từ web ngoài (Referer http/https lạ) bị từ chối.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { PluginRecord } from './PluginManager';
import { WEB_SDK_JS } from './webSdk';

export const PLUGIN_SCHEME = 'deplao-plugin';
export const SDK_PATH = '__deplao/sdk.js';
export const DEV_RENDERER_ORIGIN = 'http://localhost:27799';

const MIME: Record<string, string> = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4',
};

export function mimeFor(file: string): string {
    return MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
}

/** deplao-plugin://vn.acme.spa/ui/index.html → { pluginId, relPath: 'ui/index.html' }. */
export function parsePluginUrl(raw: string): { pluginId: string; relPath: string } | null {
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== `${PLUGIN_SCHEME}:`) return null;
    const pluginId = u.hostname.toLowerCase();
    if (!pluginId) return null;
    let rel: string;
    try { rel = decodeURIComponent(u.pathname); } catch { return null; }
    rel = rel.replace(/^\/+/, '');
    return { pluginId, relPath: rel };
}

/**
 * Đường dẫn file thật bên trong root, hoặc null nếu ra ngoài (.., tuyệt đối, symlink, ký tự lạ).
 * Thư mục → index.html bên trong.
 */
export function resolvePluginFile(root: string, relPath: string): string | null {
    if (!relPath || relPath.includes('\0') || relPath.includes('\\') || relPath.includes(':')) return null;
    if (relPath.split('/').some(seg => seg === '..')) return null;
    let rootReal: string;
    try { rootReal = fs.realpathSync(root); } catch { return null; }
    let full = path.resolve(rootReal, ...relPath.split('/').filter(Boolean));
    if (full !== rootReal && !full.startsWith(rootReal + path.sep)) return null;
    try {
        let real = fs.realpathSync(full);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
        if (fs.statSync(real).isDirectory()) {
            full = path.join(real, 'index.html');
            real = fs.realpathSync(full);
            if (!real.startsWith(rootReal + path.sep)) return null;
        }
        return fs.statSync(real).isFile() ? real : null;
    } catch {
        return null;
    }
}

export function buildCsp(rec: PluginRecord): string {
    const connect = ["'self'"];
    if (rec.granted_permissions.includes('network')) {
        for (const o of rec.manifest.ui?.connectSrc || []) {
            try { connect.push(new URL(o).origin); } catch { /* manifest đã kiểm tra */ }
        }
    }
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        `connect-src ${connect.join(' ')}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        'frame-ancestors *',
    ].join('; ');
}

/** Referer là trang web ngoài (không phải app) → không phục vụ trang plugin. */
export function isForeignReferrer(referrer: string | null | undefined, devOrigin = DEV_RENDERER_ORIGIN): boolean {
    const ref = String(referrer || '');
    if (!/^https?:/i.test(ref)) return false;
    return !ref.startsWith(devOrigin);
}

export interface ProtocolDeps {
    /** Plugin đang bật (null nếu không). */
    activeRecord(pluginId: string): PluginRecord | null;
    devOrigin?: string;
}

export async function handlePluginRequest(request: { url: string; method?: string; headers: { get(name: string): string | null }; referrer?: string }, deps: ProtocolDeps): Promise<Response> {
    const parsed = parsePluginUrl(request.url);
    if (!parsed) return new Response('Bad Request', { status: 400 });
    const method = (request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    const baseHeaders: Record<string, string> = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' };

    if (parsed.relPath === SDK_PATH) {
        return new Response(WEB_SDK_JS, { status: 200, headers: { ...baseHeaders, 'Content-Type': 'text/javascript; charset=utf-8' } });
    }

    const referrer = request.headers.get('referer') || request.referrer || '';
    if (isForeignReferrer(referrer, deps.devOrigin)) return new Response('Forbidden', { status: 403 });

    const rec = deps.activeRecord(parsed.pluginId);
    if (!rec) return new Response('Ứng dụng chưa bật', { status: 404 });
    const file = resolvePluginFile(rec.install_path, parsed.relPath || 'index.html');
    if (!file) return new Response('Not Found', { status: 404 });

    const headers: Record<string, string> = { ...baseHeaders, 'Content-Type': mimeFor(file) };
    if (rec.source_type === 'dev') headers['Cache-Control'] = 'no-store';
    if (/\.html?$/i.test(file)) headers['Content-Security-Policy'] = buildCsp(rec);
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    const data = await fs.promises.readFile(file);
    return new Response(data, { status: 200, headers });
}

/** Origin của app được đọc file qua local-media:// (không có Origin = request cùng app / no-cors). */
export function isTrustedAppOrigin(origin: string | null | undefined, devOrigin = DEV_RENDERER_ORIGIN): boolean {
    if (origin === null || origin === undefined || origin === '') return true;
    const o = origin.trim();
    return o === 'null' || o === 'file://' || o === devOrigin;
}

/** Request local-media:// đến từ plugin hoặc trang web ngoài → chặn (ACAO * + bypassCSP sẽ lộ mọi file). */
export function isBlockedMediaRequest(headers: { get(name: string): string | null }, referrer?: string, devOrigin = DEV_RENDERER_ORIGIN): boolean {
    if (!isTrustedAppOrigin(headers.get('origin'), devOrigin)) return true;
    const ref = String(headers.get('referer') || referrer || '');
    if (ref.startsWith(`${PLUGIN_SCHEME}:`)) return true;
    return false;
}

/** iframe đang ở deplao-plugin://<id> chỉ được điều hướng trong chính origin đó. */
export function shouldBlockPluginFrameNavigation(currentUrl: string, targetUrl: string): boolean {
    if (!String(currentUrl || '').startsWith(`${PLUGIN_SCHEME}:`)) return false;
    try {
        const cur = new URL(currentUrl);
        const tgt = new URL(targetUrl);
        return !(tgt.protocol === cur.protocol && tgt.host === cur.host);
    } catch {
        return true;
    }
}
