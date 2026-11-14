/**
 * PluginProtocol: serves the plugin UI through deplao-plugin://<id>/<path> (each plugin has its own origin,
 * different from the app's origin → the plugin iframe cannot reach the app's DOM / IPC).
 *
 *  - Only enabled plugins; files must be inside the plugin folder (realpath is checked, symlinks pointing outside are blocked).
 *  - Strict CSP: script/style only from the plugin itself; no fetch to the outside except ui.connectSrc, no external images except ui.imgSrc
 *    (both need the network permission).
 *  - /__deplao/sdk.js returns the web SDK embedded in the app.
 *  - Pages embedded from an unknown external web (unfamiliar http/https Referer) are rejected.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { PluginRecord } from './PluginManager';
import { isImageSource } from './manifest';
import { WEB_SDK_JS } from './webSdk';
import { tr } from '../../shared/i18n';

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
 * The real file path inside root, or null if it is outside (.., absolute, symlink, odd characters).
 * A folder → index.html inside it.
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

export function buildCsp(rec: PluginRecord, devOrigin = DEV_RENDERER_ORIGIN): string {
    const connect = ["'self'"];
    const img = ["'self'", 'data:', 'blob:'];
    if (rec.granted_permissions.includes('network')) {
        for (const o of rec.manifest.ui?.connectSrc || []) {
            try { connect.push(new URL(o).origin); } catch { /* manifest already checked */ }
        }
        // External images (e.g. Zalo avatars at https://*.zadn.vn): only sources declared in ui.imgSrc, the format is checked again.
        for (const o of rec.manifest.ui?.imgSrc || []) {
            if (isImageSource(o)) img.push(o);
        }
    }
    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        `img-src ${img.join(' ')}`,
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        `connect-src ${connect.join(' ')}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        // Who may embed the app pages: the app itself, the installed Deplao UI (file://) and the dev build (Vite). Do not use
        // '*': under CSP, '*' only matches http/https/ws/wss, so it would block the installed file:// UI (blank page) and also allow
        // any external web page to embed it.
        `frame-ancestors 'self' file: ${devOrigin}`,
    ].join('; ');
}

/** Referer is an external web page (not the app) → the plugin page is not served. */
export function isForeignReferrer(referrer: string | null | undefined, devOrigin = DEV_RENDERER_ORIGIN): boolean {
    const ref = String(referrer || '');
    if (!/^https?:/i.test(ref)) return false;
    return !ref.startsWith(devOrigin);
}

export interface ProtocolDeps {
    /** The enabled plugin (null if none). */
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
    if (!rec) return new Response(tr('Ứng dụng chưa bật'), { status: 404 });
    const file = resolvePluginFile(rec.install_path, parsed.relPath || 'index.html');
    if (!file) return new Response('Not Found', { status: 404 });

    const headers: Record<string, string> = { ...baseHeaders, 'Content-Type': mimeFor(file) };
    if (rec.source_type === 'dev') headers['Cache-Control'] = 'no-store';
    if (/\.html?$/i.test(file)) headers['Content-Security-Policy'] = buildCsp(rec, deps.devOrigin);
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    const data = await fs.promises.readFile(file);
    return new Response(data, { status: 200, headers });
}

/** App origin allowed to read files through local-media:// (no Origin = same-app request / no-cors). */
export function isTrustedAppOrigin(origin: string | null | undefined, devOrigin = DEV_RENDERER_ORIGIN): boolean {
    if (origin === null || origin === undefined || origin === '') return true;
    const o = origin.trim();
    return o === 'null' || o === 'file://' || o === devOrigin;
}

/** A local-media:// request from a plugin or an external web page → blocked (ACAO * + bypassCSP would expose every file). */
export function isBlockedMediaRequest(headers: { get(name: string): string | null }, referrer?: string, devOrigin = DEV_RENDERER_ORIGIN): boolean {
    if (!isTrustedAppOrigin(headers.get('origin'), devOrigin)) return true;
    const ref = String(headers.get('referer') || referrer || '');
    if (ref.startsWith(`${PLUGIN_SCHEME}:`)) return true;
    return false;
}

/** An iframe at deplao-plugin://<id> may only navigate inside that same origin. */
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
