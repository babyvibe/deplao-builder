/**
 * The Deplao UI CSP in the installed build (the dev build runs Vite at http://localhost:27799 and does not set this header).
 *
 *  - frame-src with `deplao-plugin:`: app pages (plugins) run in an iframe at deplao-plugin://<id>. Without it, the installed build
 *    blocks the app frame (blank page) even though the dev build still runs.
 *  - Applies only to Deplao's own content. Web pages that share the session (internal browser, windows opened with window.open,
 *    Telegram mini apps, https frames embedded in chat) stay as in the dev build: the app's `script-src 'self'` blocks inline
 *    script and CDNs, so those pages cannot run.
 *  - Responses from deplao-plugin:// keep their own CSP (PluginProtocol.buildCsp: stricter, based on the app's permissions);
 *    overwriting them with the app CSP would loosen connect-src / img-src for the app.
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // img-src and media-src must allow https: to load images and videos from the Zalo CDN
  "img-src 'self' data: local-media: blob: https: http:",
  "media-src 'self' local-media: blob: https: http:",
  "connect-src 'self' https: http: wss:",
  "font-src 'self' data: https:",
  "frame-src 'self' https: deplao-plugin:",
].join('; ') + ';';

/** The fields of details needed by session.webRequest.onHeadersReceived. */
export interface CspResponseDetails {
  url: string;
  resourceType?: string;
  webContentsId?: number;
  responseHeaders?: Record<string, string | string[]>;
}

/** Deplao's own content: the installed UI + bundled files (file://) and local files on the machine (local-media://). */
const OWN_CONTENT_RE = /^(file|local-media):/i;

/**
 * Headers returned to onHeadersReceived; null = keep the response as is.
 * Attaches the app CSP to Deplao's content and to the main window's main page (even if it accidentally navigated to the web), not
 * to web pages in other windows or to embedded https frames.
 */
export function rendererCspHeaders(
  details: CspResponseDetails,
  mainWebContentsId: number | null,
): Record<string, string | string[]> | null {
  const url = String(details.url || '');
  if (/^deplao-plugin:/i.test(url)) return null;
  const mainPage = details.resourceType === 'mainFrame'
    && mainWebContentsId != null
    && details.webContentsId === mainWebContentsId;
  if (!OWN_CONTENT_RE.test(url) && !mainPage) return null;
  return { ...(details.responseHeaders || {}), 'Content-Security-Policy': [RENDERER_CSP] };
}
